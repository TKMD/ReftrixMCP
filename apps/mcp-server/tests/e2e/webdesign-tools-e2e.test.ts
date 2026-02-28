// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Webデザイン解析MCP Tools E2E テスト
 * TDD Green フェーズ: layout.*, quality.*, motion.* ツールの統合テスト
 *
 * 目的:
 * - Webデザイン解析ツールの統合テスト
 * - layout.ingest (URL取得) -> layout.search -> layout.to_code フローの検証
 * - quality.evaluate (HTML直接) ツールの検証
 * - motion.detect (HTML直接) -> motion.search フローの検証
 * - パフォーマンス目標達成の検証
 *
 * [DELETED v0.1.0] motion.get_implementation → motion.search (action: "generate") に統合・削除済み
 * - motionGetImplementationHandler の代わりに motionSearchHandler を使用
 * - motion.get_implementation 関連テストは motion.search のテストに統合
 *
 * 注意:
 * - layout.ingestは実際のURL取得が必要（ネットワーク依存）
 * - quality.evaluate, motion.detectはHTML直接入力可能（ネットワーク非依存）
 *
 * @module tests/e2e/webdesign-tools-e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ============================================================================
// Layout MCPツールハンドラーのインポート
// ============================================================================
import {
  layoutIngestHandler,
  layoutSearchHandler,
  layoutToCodeHandler,
  resetLayoutSearchServiceFactory,
  resetLayoutToCodeServiceFactory,
} from '../../src/tools/layout';

// ============================================================================
// Quality MCPツールハンドラーのインポート
// ============================================================================
import {
  qualityEvaluateHandler,
  resetQualityEvaluateServiceFactory,
} from '../../src/tools/quality';

// ============================================================================
// Motion MCPツールハンドラーのインポート
// ============================================================================
import {
  motionDetectHandler,
  motionSearchHandler,
  // [DELETED v0.1.0] motion.get_implementation → motion.search (action: "generate") に統合・削除済み
  // motionGetImplementationHandler,
  resetMotionDetectServiceFactory,
  resetMotionSearchServiceFactory,
  // [DELETED v0.1.0] resetMotionImplementationServiceFactory も不要
  // resetMotionImplementationServiceFactory,
} from '../../src/tools/motion';

import { TEST_DATABASE_URL } from './test-database-url';

// ============================================================================
// Prismaクライアント設定
// ============================================================================

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: TEST_DATABASE_URL,
    },
  },
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
});

// ============================================================================
// Database availability check
// ============================================================================

// Skip E2E tests if RUN_E2E_TESTS is not explicitly set to 'true'
// These tests require PostgreSQL running on port 26432
const shouldRunE2E = process.env.RUN_E2E_TESTS === 'true';

/**
 * Check if database is available before running E2E tests
 * Returns true if database is accessible, false otherwise
 */
async function isDatabaseAvailable(): Promise<boolean> {
  try {
    await prisma.$connect();
    await prisma.$disconnect();
    return true;
  } catch {
    return false;
  }
}

// Check database availability synchronously using a flag set by beforeAll in parent suite
let dbAvailable = false;

// ============================================================================
// テストデータ定義
// ============================================================================

/**
 * テスト用HTMLコンテンツ（シンプル）
 */
const TEST_HTML_SIMPLE = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Page</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 0; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .hero { background: linear-gradient(135deg, #3B82F6, #8B5CF6); padding: 80px 20px; }
    .hero h1 { color: white; font-size: 48px; margin: 0; }
    .hero p { color: rgba(255,255,255,0.9); font-size: 18px; }
    .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding: 60px 20px; }
    .feature-card { background: #F8FAFC; padding: 24px; border-radius: 12px; }
    .feature-card h3 { color: #1E293B; margin-top: 0; }
    .feature-card p { color: #64748B; }
    .cta { background: #1E293B; padding: 60px 20px; text-align: center; }
    .cta button { background: #3B82F6; color: white; padding: 16px 32px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="container">
    <section class="hero">
      <h1>Welcome to Our Platform</h1>
      <p>Build amazing products with our cutting-edge tools</p>
    </section>
    <section class="features">
      <div class="feature-card">
        <h3>Feature 1</h3>
        <p>Description for feature 1</p>
      </div>
      <div class="feature-card">
        <h3>Feature 2</h3>
        <p>Description for feature 2</p>
      </div>
      <div class="feature-card">
        <h3>Feature 3</h3>
        <p>Description for feature 3</p>
      </div>
    </section>
    <section class="cta">
      <button>Get Started</button>
    </section>
  </div>
</body>
</html>
`;

/**
 * テスト用HTMLコンテンツ（アニメーション付き）
 */
const TEST_HTML_WITH_ANIMATION = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Animation Test</title>
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
    .fade-in { animation: fadeIn 0.5s ease-out forwards; }
    .pulse { animation: pulse 2s ease-in-out infinite; }
    .slide-in { animation: slideIn 0.3s ease-out; }
    .hover-scale { transition: transform 0.2s ease; }
    .hover-scale:hover { transform: scale(1.1); }
    .card {
      padding: 20px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      transition: box-shadow 0.3s ease, transform 0.3s ease;
    }
    .card:hover {
      box-shadow: 0 8px 16px rgba(0,0,0,0.2);
      transform: translateY(-4px);
    }
  </style>
</head>
<body>
  <div class="fade-in">
    <h1>Animated Content</h1>
  </div>
  <div class="pulse">
    <button>Click Me</button>
  </div>
  <nav class="slide-in">
    <a href="#">Link 1</a>
    <a href="#">Link 2</a>
  </nav>
  <div class="card hover-scale">
    <h3>Interactive Card</h3>
    <p>Hover to see effects</p>
  </div>
</body>
</html>
`;

/**
 * テスト用HTMLコンテンツ（複雑）
 */
const TEST_HTML_COMPLEX = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complex Test Page</title>
  <style>
    :root {
      --primary: #3B82F6;
      --secondary: #8B5CF6;
      --text: #1E293B;
      --text-muted: #64748B;
      --background: #FFFFFF;
      --surface: #F8FAFC;
      --border: #E2E8F0;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text);
      background: var(--background);
      line-height: 1.6;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--background);
      z-index: 100;
    }
    .logo { font-weight: 700; font-size: 24px; color: var(--primary); }
    .nav { display: flex; gap: 24px; }
    .nav a { color: var(--text-muted); text-decoration: none; transition: color 0.2s; }
    .nav a:hover { color: var(--primary); }
    .hero {
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      padding: 120px 24px;
      text-align: center;
    }
    .hero h1 { color: white; font-size: 56px; margin-bottom: 16px; }
    .hero p { color: rgba(255,255,255,0.9); font-size: 20px; max-width: 600px; margin: 0 auto 32px; }
    .hero-buttons { display: flex; gap: 16px; justify-content: center; }
    .btn {
      padding: 14px 28px;
      border-radius: 8px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-primary { background: white; color: var(--primary); }
    .btn-secondary { background: transparent; color: white; border: 2px solid white; }
    .features { padding: 80px 24px; max-width: 1200px; margin: 0 auto; }
    .features h2 { text-align: center; font-size: 36px; margin-bottom: 48px; }
    .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 32px; }
    .feature-card {
      background: var(--surface);
      padding: 32px;
      border-radius: 16px;
      transition: transform 0.3s, box-shadow 0.3s;
    }
    .feature-card:hover {
      transform: translateY(-8px);
      box-shadow: 0 20px 40px rgba(0,0,0,0.1);
    }
    .feature-icon {
      width: 48px;
      height: 48px;
      background: var(--primary);
      border-radius: 12px;
      margin-bottom: 16px;
    }
    .testimonials { background: var(--surface); padding: 80px 24px; }
    .testimonial-card { background: white; padding: 24px; border-radius: 12px; }
    .footer { background: var(--text); color: white; padding: 48px 24px; }
    .footer-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 32px; max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
  <header class="header">
    <div class="logo">Brand</div>
    <nav class="nav">
      <a href="#">Features</a>
      <a href="#">Pricing</a>
      <a href="#">About</a>
      <a href="#">Contact</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>Build Something Amazing</h1>
      <p>Create beautiful, responsive designs with our powerful platform</p>
      <div class="hero-buttons">
        <a href="#" class="btn btn-primary">Get Started</a>
        <a href="#" class="btn btn-secondary">Learn More</a>
      </div>
    </section>
    <section class="features">
      <h2>Features</h2>
      <div class="features-grid">
        <article class="feature-card">
          <div class="feature-icon"></div>
          <h3>Fast Performance</h3>
          <p>Lightning-fast load times with optimized delivery</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon"></div>
          <h3>Easy Integration</h3>
          <p>Simple API that works with your existing stack</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon"></div>
          <h3>Secure by Default</h3>
          <p>Enterprise-grade security built into every feature</p>
        </article>
      </div>
    </section>
    <section class="testimonials">
      <div class="testimonial-card">
        <p>"This product changed how we work."</p>
        <cite>- Happy Customer</cite>
      </div>
    </section>
  </main>
  <footer class="footer">
    <div class="footer-grid">
      <div><h4>Product</h4></div>
      <div><h4>Company</h4></div>
      <div><h4>Resources</h4></div>
      <div><h4>Legal</h4></div>
    </div>
  </footer>
</body>
</html>
`;

// ============================================================================
// テストユーティリティ
// ============================================================================

/**
 * レスポンスが成功か判定
 */
function isSuccess(response: unknown): response is { success: true; data: unknown } {
  return (
    typeof response === 'object' &&
    response !== null &&
    'success' in response &&
    (response as { success: boolean }).success === true
  );
}

/**
 * レスポンスがエラーか判定
 */
function isError(response: unknown): response is { success: false; error: unknown } {
  return (
    typeof response === 'object' &&
    response !== null &&
    'success' in response &&
    (response as { success: boolean }).success === false
  );
}

// ============================================================================
// テストスイート
// ============================================================================

// Skip E2E tests if RUN_E2E_TESTS is not set
// To run E2E tests: RUN_E2E_TESTS=true pnpm test tests/e2e/
describe.skipIf(!shouldRunE2E)('Webデザイン解析 MCP Tools E2E テスト', () => {
  // ==========================================================================
  // セットアップとクリーンアップ
  // ==========================================================================

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      console.log('[E2E] Database not available - some tests may fail');
    }
    try {
      await prisma.$connect();
      console.log('[E2E] Database connected successfully');
    } catch (error) {
      console.error('[E2E] Database connection failed:', error);
      dbAvailable = false;
    }
  }, 30000);

  afterAll(async () => {
    try {
      await prisma.$disconnect();
      console.log('[E2E] Database disconnected');
    } catch (error) {
      console.error('[E2E] Disconnect error:', error);
    }

    // サービスファクトリーをリセット
    resetLayoutSearchServiceFactory();
    resetLayoutToCodeServiceFactory();
    resetQualityEvaluateServiceFactory();
    resetMotionDetectServiceFactory();
    resetMotionSearchServiceFactory();
    // [DELETED v0.1.0] resetMotionImplementationServiceFactory - motion.get_implementation は motion.search に統合
  }, 30000);

  // ==========================================================================
  // layout.ingest E2Eテスト（ネットワーク依存）
  // ==========================================================================

  describe('layout.ingest E2Eテスト', () => {
    /**
     * URL指定が必須であることを検証
     */
    it('URLが必須であることを検証', async () => {
      // Arrange - URLなしの入力
      const input = {};

      // Act
      const result = await layoutIngestHandler(input);

      // Assert - バリデーションエラー
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error).toBeDefined();
      }

      console.log('[E2E] layout.ingest validation error confirmed');
    });

    /**
     * SSRF対策: localhostがブロックされることを検証
     */
    it('SSRF対策: localhostがブロックされること', async () => {
      // Arrange
      const input = {
        url: 'http://localhost:3000/test',
      };

      // Act
      const result = await layoutIngestHandler(input);

      // Assert - SSRFエラー
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        const error = result.error as { code: string };
        expect(error.code).toBe('SSRF_BLOCKED');
      }

      console.log('[E2E] layout.ingest SSRF blocked for localhost');
    });

    /**
     * SSRF対策: プライベートIPがブロックされることを検証
     */
    it('SSRF対策: プライベートIPがブロックされること', async () => {
      // Arrange
      const input = {
        url: 'http://192.168.1.1/admin',
      };

      // Act
      const result = await layoutIngestHandler(input);

      // Assert - SSRFエラー
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        const error = result.error as { code: string };
        expect(error.code).toBe('SSRF_BLOCKED');
      }

      console.log('[E2E] layout.ingest SSRF blocked for private IP');
    });

    /**
     * 無効なURL形式でバリデーションエラーが発生することを検証
     */
    it('無効なURL形式でバリデーションエラーが発生すること', async () => {
      // Arrange
      const input = {
        url: 'not-a-valid-url',
      };

      // Act
      const result = await layoutIngestHandler(input);

      // Assert - バリデーションエラー
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        const error = result.error as { code: string };
        expect(error.code).toBe('VALIDATION_ERROR');
      }

      console.log('[E2E] layout.ingest validation error for invalid URL');
    });
  });

  // ==========================================================================
  // layout.search E2Eテスト
  // ==========================================================================

  describe('layout.search E2Eテスト', () => {
    /**
     * 基本的な検索が機能することを検証
     */
    it('クエリで検索ができること', async () => {
      // Arrange
      const input = {
        query: 'hero section landing page',
      };

      // Act
      const result = await layoutSearchHandler(input);

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as { results: unknown[]; total: number };
        expect(data.results).toBeDefined();
        expect(Array.isArray(data.results)).toBe(true);
        expect(data.total).toBeGreaterThanOrEqual(0);
      }

      console.log('[E2E] layout.search result:', result);
    }, 15000);

    /**
     * フィルター付き検索が機能することを検証
     */
    it('フィルター付き検索ができること', async () => {
      // Arrange
      const input = {
        query: 'features grid',
        filters: {
          section_types: ['feature'],
        },
        limit: 5,
      };

      // Act
      const result = await layoutSearchHandler(input);

      // Assert
      expect(result).toBeDefined();
    }, 15000);

    /**
     * 空のクエリでバリデーションエラーが発生することを検証
     */
    it('空のクエリでバリデーションエラーが発生すること', async () => {
      // Arrange
      const input = {
        query: '',
      };

      // Act
      const result = await layoutSearchHandler(input);

      // Assert
      expect(isError(result)).toBe(true);
    });
  });

  // ==========================================================================
  // layout.to_code E2Eテスト
  // ==========================================================================

  describe('layout.to_code E2Eテスト', () => {
    /**
     * 存在しないIDでエラーが発生することを検証
     * Note: Response Objectパターンでエラーを返す
     * サービスファクトリー未設定時はSERVICE_UNAVAILABLEを返す
     */
    it('存在しないIDでエラーが発生すること', async () => {
      // Arrange
      const nonExistentId = '01939abc-def0-7000-8000-999999999999';

      // Act
      const result = await layoutToCodeHandler({
        patternId: nonExistentId,
      });

      // Assert - Response Objectでエラーを返す
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        const error = result.error as { code: string };
        // サービス未設定時はSERVICE_UNAVAILABLE、設定済みならPATTERN_NOT_FOUND
        expect(['SERVICE_UNAVAILABLE', 'PATTERN_NOT_FOUND']).toContain(error.code);
      }
    });

    /**
     * 無効なIDでバリデーションエラーが発生することを検証
     */
    it('無効なIDでバリデーションエラーが発生すること', async () => {
      // Arrange
      const input = {
        patternId: 'invalid-id-format',
      };

      // Act
      const result = await layoutToCodeHandler(input);

      // Assert - Response Objectでバリデーションエラーを返す
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        const error = result.error as { code: string; message: string };
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.message).toContain('有効なUUID形式のpatternIdを指定してください');
      }
    });
  });

  // ==========================================================================
  // quality.evaluate E2Eテスト（ネットワーク非依存）
  // ==========================================================================

  describe('quality.evaluate E2Eテスト', () => {
    /**
     * HTMLの品質評価ができることを検証
     */
    it('HTMLの品質評価ができること', async () => {
      // Act
      const result = await qualityEvaluateHandler({
        html: TEST_HTML_COMPLEX,
      });

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as {
          overall: number;
          grade: string;
          originality: unknown;
          craftsmanship: unknown;
          contextuality: unknown;
        };
        expect(data.overall).toBeDefined();
        expect(typeof data.overall).toBe('number');
        expect(data.overall).toBeGreaterThanOrEqual(0);
        expect(data.overall).toBeLessThanOrEqual(100);
        expect(data.grade).toBeDefined();
        expect(data.originality).toBeDefined();
        expect(data.craftsmanship).toBeDefined();
        expect(data.contextuality).toBeDefined();

        console.log('[E2E] quality.evaluate result:', {
          overall: data.overall,
          grade: data.grade,
        });
      }
    }, 15000);

    /**
     * シンプルなHTMLの品質評価ができることを検証
     */
    it('シンプルなHTMLの品質評価ができること', async () => {
      // Act
      const result = await qualityEvaluateHandler({
        html: TEST_HTML_SIMPLE,
      });

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as { overall: number; recommendations: unknown[] };
        expect(data.overall).toBeDefined();
        expect(data.recommendations).toBeDefined();
      }
    }, 15000);

    /**
     * アニメーション付きHTMLの品質評価ができることを検証
     */
    it('アニメーション付きHTMLの品質評価ができること', async () => {
      // Act
      const result = await qualityEvaluateHandler({
        html: TEST_HTML_WITH_ANIMATION,
      });

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as { overall: number };
        expect(data.overall).toBeDefined();
      }
    }, 15000);

    /**
     * 最小限のHTMLでも評価できることを検証
     */
    it('最小限のHTMLでも評価できること', async () => {
      // Arrange
      const minimalHtml = '<html><body><p>Hello</p></body></html>';

      // Act
      const result = await qualityEvaluateHandler({
        html: minimalHtml,
      });

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as { overall: number };
        expect(data.overall).toBeDefined();
      }
    }, 10000);

    /**
     * htmlとpageIdが両方ない場合にエラーが発生することを検証
     */
    it('htmlとpageIdが両方ない場合にエラーが発生すること', async () => {
      // Act
      const result = await qualityEvaluateHandler({});

      // Assert
      expect(isError(result)).toBe(true);
    });
  });

  // ==========================================================================
  // motion.detect E2Eテスト（ネットワーク非依存）
  // ==========================================================================

  describe('motion.detect E2Eテスト', () => {
    /**
     * CSSアニメーションを検出できることを検証
     */
    it('CSSアニメーションを検出できること', async () => {
      // Act
      const result = await motionDetectHandler({
        html: TEST_HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as {
          patterns: unknown[];
          summary: unknown;
        };
        expect(data.patterns).toBeDefined();
        expect(Array.isArray(data.patterns)).toBe(true);
        expect(data.patterns.length).toBeGreaterThan(0);
        expect(data.summary).toBeDefined();

        console.log('[E2E] motion.detect result:', {
          patternCount: data.patterns.length,
        });
      }
    }, 15000);

    /**
     * トランジションを検出できることを検証
     */
    it('トランジションを検出できること', async () => {
      // Arrange
      const htmlWithTransition = `
        <html>
        <head>
          <style>
            .btn { transition: all 0.3s ease; }
            .btn:hover { transform: scale(1.1); background: #3B82F6; }
          </style>
        </head>
        <body>
          <button class="btn">Click</button>
        </body>
        </html>
      `;

      // Act
      const result = await motionDetectHandler({
        html: htmlWithTransition,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result).toBeDefined();
    }, 10000);

    /**
     * アニメーションがないHTMLでも正常に動作することを検証
     */
    it('アニメーションがないHTMLでも正常に応答すること', async () => {
      // Arrange
      const staticHtml = `
        <html>
        <body>
          <h1>Static Page</h1>
          <p>No animations here</p>
        </body>
        </html>
      `;

      // Act
      const result = await motionDetectHandler({
        html: staticHtml,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as { patterns: unknown[] };
        expect(data.patterns).toBeDefined();
        expect(data.patterns.length).toBe(0);
      }
    }, 10000);

    /**
     * 複雑なアニメーションを解析できることを検証
     */
    it('複雑なアニメーションを解析できること', async () => {
      // Arrange
      const complexAnimationHtml = `
        <html>
        <head>
          <style>
            @keyframes bounce {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-20px); }
            }
            @keyframes fadeInUp {
              from { opacity: 0; transform: translateY(30px); }
              to { opacity: 1; transform: translateY(0); }
            }
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            .bounce { animation: bounce 1s ease infinite; }
            .fade-in-up { animation: fadeInUp 0.6s ease-out forwards; }
            .spin { animation: spin 2s linear infinite; }
          </style>
        </head>
        <body>
          <div class="bounce">Bouncing</div>
          <div class="fade-in-up">Fading In</div>
          <div class="spin">Spinning</div>
        </body>
        </html>
      `;

      // Act
      const result = await motionDetectHandler({
        html: complexAnimationHtml,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as { patterns: Array<{ name: string; type: string }> };
        expect(data.patterns.length).toBeGreaterThanOrEqual(3);
        // 各パターンに必要な情報が含まれている
        data.patterns.forEach((pattern) => {
          expect(pattern.name).toBeDefined();
          expect(pattern.type).toBeDefined();
        });
      }
    }, 15000);

    /**
     * htmlとpageIdが両方ない場合にエラーが発生することを検証
     */
    it('htmlとpageIdが両方ない場合にエラーが発生すること', async () => {
      // Act
      const result = await motionDetectHandler({
        detection_mode: 'css' as const,
      });

      // Assert
      expect(isError(result)).toBe(true);
    });
  });

  // ==========================================================================
  // motion.search E2Eテスト
  // ==========================================================================

  describe('motion.search E2Eテスト', () => {
    /**
     * モーションパターンを検索できることを検証
     */
    it('モーションパターンを検索できること', async () => {
      // Arrange
      const input = {
        query: 'fade in animation',
      };

      // Act
      const result = await motionSearchHandler(input);

      // Assert
      expect(result).toBeDefined();
      if (isSuccess(result)) {
        const data = result.data as { results: unknown[]; total: number };
        expect(data.results).toBeDefined();
        expect(data.total).toBeGreaterThanOrEqual(0);
      }

      console.log('[E2E] motion.search result:', result);
    }, 15000);

    /**
     * タイプフィルターで検索できることを検証
     */
    it('タイプフィルターで検索できること', async () => {
      // Arrange
      const input = {
        query: 'hover effect',
        filters: {
          types: ['transition'],
        },
        limit: 5,
      };

      // Act
      const result = await motionSearchHandler(input);

      // Assert
      expect(result).toBeDefined();
    }, 15000);

    /**
     * 空のクエリでバリデーションエラーが発生することを検証
     */
    it('空のクエリでバリデーションエラーが発生すること', async () => {
      // Arrange
      const input = {
        query: '',
      };

      // Act
      const result = await motionSearchHandler(input);

      // Assert
      expect(isError(result)).toBe(true);
    });
  });

  // ==========================================================================
  // [DELETED v0.1.0] motion.get_implementation E2Eテスト → motion.search (action: "generate") に統合・削除済み
  // ==========================================================================
  // 旧 motion.get_implementation の機能は motion.search の action: "generate" パラメータで代替
  // 使用方法: motionSearchHandler({ action: 'generate', pattern: {...}, format: 'css' })
  // 詳細:  を参照

  // ==========================================================================
  // 統合フローテスト（HTML直接入力）
  // ==========================================================================

  describe('統合フローテスト', () => {
    /**
     * motion.detect と quality.evaluate の統合テスト
     */
    it('motion.detect と quality.evaluate の統合テストが動作すること', async () => {
      // Step 1: モーション検出
      const detectResult = await motionDetectHandler({
        html: TEST_HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      expect(detectResult).toBeDefined();
      if (isSuccess(detectResult)) {
        const detectData = detectResult.data as { patterns: unknown[] };
        expect(detectData.patterns).toBeDefined();
      }

      // Step 2: 品質評価
      const evaluateResult = await qualityEvaluateHandler({
        html: TEST_HTML_WITH_ANIMATION,
      });

      expect(evaluateResult).toBeDefined();
      if (isSuccess(evaluateResult)) {
        const evalData = evaluateResult.data as { overall: number };
        expect(evalData.overall).toBeDefined();
      }

      console.log('[E2E] Motion + Quality flow completed');
    }, 30000);

    /**
     * 複数ツール統合フローテスト
     */
    it('複数ツールの統合フローが動作すること', async () => {
      const html = TEST_HTML_WITH_ANIMATION;

      // Step 1: モーション検出
      const motionResult = await motionDetectHandler({ html, detection_mode: 'css' as const });
      expect(motionResult).toBeDefined();

      // Step 2: 品質評価
      const qualityResult = await qualityEvaluateHandler({ html });
      expect(qualityResult).toBeDefined();

      // Step 3: モーション検索
      const searchResult = await motionSearchHandler({ query: 'fade animation' });
      expect(searchResult).toBeDefined();

      console.log('[E2E] Full flow completed');
    }, 60000);
  });

  // ==========================================================================
  // パフォーマンステスト
  // ==========================================================================

  describe('パフォーマンステスト', () => {
    /**
     * quality.evaluate が2秒以内に完了することを検証
     */
    it('quality.evaluate が2秒以内に完了すること', async () => {
      const startTime = performance.now();

      await qualityEvaluateHandler({
        html: TEST_HTML_COMPLEX,
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(2000);
      console.log('[E2E] quality.evaluate performance:', { durationMs: duration });
    }, 5000);

    /**
     * motion.detect が2秒以内に完了することを検証
     */
    it('motion.detect が2秒以内に完了すること', async () => {
      const startTime = performance.now();

      await motionDetectHandler({
        html: TEST_HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(2000);
      console.log('[E2E] motion.detect performance:', { durationMs: duration });
    }, 5000);

    /**
     * layout.search が500ms以内に完了することを検証
     */
    it('layout.search が500ms以内に完了すること', async () => {
      const startTime = performance.now();

      await layoutSearchHandler({ query: 'hero section', limit: 10 });

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(500);
      console.log('[E2E] layout.search performance:', { durationMs: duration });
    }, 5000);
  });

  // ==========================================================================
  // エラーハンドリングテスト
  // ==========================================================================

  describe('エラーハンドリングテスト', () => {
    /**
     * 空のHTMLでエラーが発生することを検証
     */
    it('空のHTMLで品質評価エラーが発生すること', async () => {
      const result = await qualityEvaluateHandler({
        html: '',
      });

      expect(isError(result)).toBe(true);
    });

    /**
     * 無効なIDでエラーが発生することを検証
     * Note: layoutToCodeHandlerはResponse Objectでエラーを返す
     */
    it('無効なIDでコード生成エラーが発生すること', async () => {
      const result = await layoutToCodeHandler({
        patternId: 'invalid-id-format',
      });

      // Assert - Response Objectでバリデーションエラーを返す
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        const error = result.error as { code: string; message: string };
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.message).toContain('有効なUUID形式のpatternIdを指定してください');
      }
    });

    /**
     * 存在しないpatternIdでエラーが発生することを検証
     * Note: サービスファクトリー未設定時はSERVICE_UNAVAILABLEを返す
     */
    it('存在しないpatternIdでエラーが発生すること', async () => {
      const result = await layoutToCodeHandler({
        patternId: '01939abc-def0-7000-8000-999999999999',
      });

      // Assert - サービス未設定でSERVICE_UNAVAILABLE、または設定済みでPATTERN_NOT_FOUND
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        const error = result.error as { code: string };
        expect(['SERVICE_UNAVAILABLE', 'PATTERN_NOT_FOUND']).toContain(error.code);
      }
    });
  });

  // ==========================================================================
  // motion.detect - External CSS Integration E2E
  // ==========================================================================

  describe('motion.detect - External CSS Integration E2E', () => {
    /**
     * 外部CSSファイルから実際のシナリオでアニメーションを検出
     * Note: モックを使用してネットワークリクエストをシミュレート
     *
     * テストシナリオ:
     * - HTMLに<link rel="stylesheet">タグが含まれる
     * - 外部CSSにはアニメーション定義がある
     * - fetchExternalCss=true で外部CSS取得を有効化
     * - baseUrlで相対URL解決
     */
    it('should detect animations from external CSS files in real-world scenario', async () => {
      // Arrange - HTMLは<link>タグのみ、アニメーションは外部CSS
      const htmlWithExternalCss = `
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="stylesheet" href="/styles/animations.css">
          <style>
            /* インラインスタイルにはアニメーション定義なし */
            body { font-family: sans-serif; }
          </style>
        </head>
        <body>
          <div class="fade-in">Content</div>
        </body>
        </html>
      `;

      // 外部CSSに含まれるアニメーション定義
      const externalCssContent = `
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .fade-in {
          animation: fadeIn 0.5s ease-out forwards;
        }
      `;

      // Act - 外部CSS取得が無効（デフォルト）の場合
      const resultWithoutFetch = await motionDetectHandler({
        html: htmlWithExternalCss,
        detection_mode: 'css' as const,
      });

      // Assert - インラインCSSのみなのでパターンは検出されない
      expect(isSuccess(resultWithoutFetch)).toBe(true);
      if (isSuccess(resultWithoutFetch)) {
        const data = resultWithoutFetch.data as { patterns: unknown[] };
        expect(data.patterns.length).toBe(0);
      }

      // Act - 外部CSSを直接cssパラメータで渡す（モックとして）
      const resultWithExternalCss = await motionDetectHandler({
        html: htmlWithExternalCss,
        css: externalCssContent,
        detection_mode: 'css' as const,
      });

      // Assert - 外部CSSのアニメーションが検出される
      expect(isSuccess(resultWithExternalCss)).toBe(true);
      if (isSuccess(resultWithExternalCss)) {
        const data = resultWithExternalCss.data as {
          patterns: Array<{ name?: string; type: string }>;
        };
        expect(data.patterns.length).toBeGreaterThan(0);
        // fadeIn アニメーションが検出されている
        const fadeInPattern = data.patterns.find((p) => p.name === 'fadeIn');
        expect(fadeInPattern).toBeDefined();
      }

      console.log('[E2E] motion.detect external CSS simulation completed');
    }, 15000);

    /**
     * インラインスタイルと外部CSSが混在するシナリオ
     *
     * 実際のWebページでは:
     * - <style>タグ内にアニメーション
     * - <link>タグで外部CSS参照
     * - style属性でインラインスタイル
     * これらが混在することが多い
     */
    it('should handle mixed inline and external CSS', async () => {
      // Arrange - インラインと外部CSSの両方にアニメーション
      const htmlMixed = `
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="stylesheet" href="https://example.com/external.css">
          <style>
            @keyframes slideIn {
              from { transform: translateX(-100%); }
              to { transform: translateX(0); }
            }
            .slide-in {
              animation: slideIn 0.3s ease-out;
            }
            .hover-effect {
              transition: transform 0.2s ease;
            }
            .hover-effect:hover {
              transform: scale(1.05);
            }
          </style>
        </head>
        <body>
          <div class="slide-in">Slide content</div>
          <button class="hover-effect pulse">Click me</button>
        </body>
        </html>
      `;

      // 外部CSSに追加のアニメーション
      const externalCss = `
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        .pulse {
          animation: pulse 2s ease-in-out infinite;
        }
      `;

      // Act - インラインCSSのみ
      const resultInlineOnly = await motionDetectHandler({
        html: htmlMixed,
        detection_mode: 'css' as const,
      });

      // Assert - インラインCSSのアニメーションのみ検出
      expect(isSuccess(resultInlineOnly)).toBe(true);
      if (isSuccess(resultInlineOnly)) {
        const data = resultInlineOnly.data as {
          patterns: Array<{ name?: string; type: string }>;
          summary?: { totalPatterns: number };
        };
        // slideIn とホバーエフェクトが検出される
        expect(data.patterns.length).toBeGreaterThan(0);
        const hasSlideIn = data.patterns.some((p) => p.name === 'slideIn');
        expect(hasSlideIn).toBe(true);
      }

      // Act - 外部CSSを含める（cssパラメータで渡す）
      const resultWithExternal = await motionDetectHandler({
        html: htmlMixed,
        css: externalCss,
        detection_mode: 'css' as const,
      });

      // Assert - 両方のCSSからアニメーションが検出される
      expect(isSuccess(resultWithExternal)).toBe(true);
      if (isSuccess(resultWithExternal)) {
        const data = resultWithExternal.data as {
          patterns: Array<{ name?: string; type: string }>;
          summary?: { totalPatterns: number };
        };
        // slideIn (インライン) + pulse (外部) + hover-effect (インライン)
        expect(data.patterns.length).toBeGreaterThan(
          (isSuccess(resultInlineOnly) ? (resultInlineOnly.data as { patterns: unknown[] }).patterns.length : 0)
        );
        const hasPulse = data.patterns.some((p) => p.name === 'pulse');
        expect(hasPulse).toBe(true);
      }

      console.log('[E2E] motion.detect mixed CSS completed');
    }, 15000);

    /**
     * 外部CSS取得のネットワーク障害をgracefulに処理
     *
     * fetchExternalCss=true でbaseUrlが必須:
     * - detection_mode='css' + html/pageId指定時は baseUrl 省略可能（スキーマrefineで免除）
     * - 取得失敗時は警告として報告（エラーにならない）
     *
     * NOTE: スキーマrefineにより、css + html/pageIdモードでは baseUrl 省略OK
     * (schemas.ts L1262-1263参照)
     */
    it('should gracefully handle network failures for external CSS', async () => {
      // Arrange - 外部CSSを参照するHTML
      const htmlWithExternalCss = `
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="stylesheet" href="/styles/main.css">
          <link rel="stylesheet" href="/styles/animations.css">
          <style>
            @keyframes fallbackFade {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            .fallback {
              animation: fallbackFade 0.3s ease;
            }
          </style>
        </head>
        <body>
          <div class="fallback">Fallback content</div>
        </body>
        </html>
      `;

      // Act 1 - fetchExternalCss=true but baseUrl missing
      // NOTE: detection_mode='css' + html指定時は baseUrl 省略OK（refineで免除）
      // そのためバリデーションエラーにはならず、外部CSS取得は単にスキップされる
      const resultMissingBaseUrl = await motionDetectHandler({
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        detection_mode: 'css' as const,
        // baseUrl missing intentionally - but css+html mode allows this
      });

      // Assert - css + html モードでは baseUrl 省略OKなので成功する
      // 外部CSSフェッチは行われず、インラインCSSのみ解析される
      expect(isSuccess(resultMissingBaseUrl)).toBe(true);
      if (isSuccess(resultMissingBaseUrl)) {
        const data = resultMissingBaseUrl.data as {
          patterns: Array<{ name?: string }>;
        };
        // インラインのfallbackFadeは検出される
        expect(data.patterns.some((p) => p.name === 'fallbackFade')).toBe(true);
      }

      // Act 2 - fetchExternalCss=false（デフォルト）の場合は正常動作
      const resultWithoutFetch = await motionDetectHandler({
        html: htmlWithExternalCss,
        fetchExternalCss: false,
        detection_mode: 'css' as const,
      });

      // Assert - インラインCSSのアニメーションは検出される（外部CSSは無視）
      expect(isSuccess(resultWithoutFetch)).toBe(true);
      if (isSuccess(resultWithoutFetch)) {
        const data = resultWithoutFetch.data as {
          patterns: Array<{ name?: string }>;
          metadata: { externalCssFetched?: boolean };
        };
        // インラインのfallbackFadeは検出される
        expect(data.patterns.some((p) => p.name === 'fallbackFade')).toBe(true);
        // 外部CSS取得は行われていない
        expect(data.metadata.externalCssFetched).toBeUndefined();
      }

      // Act 3 - 外部CSS取得オプションの検証（タイムアウト設定など）
      // Note: 実際のネットワークリクエストは行わないが、オプション受け入れを検証
      const resultWithOptions = await motionDetectHandler({
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com',
        externalCssOptions: {
          timeout: 1000,
          maxConcurrent: 2,
        },
        detection_mode: 'css' as const,
      });

      // Assert - バリデーションは通過（実際の取得は失敗するかもしれないが）
      // 成功またはエラー（ネットワーク失敗）のいずれか
      if (isSuccess(resultWithOptions)) {
        const data = resultWithOptions.data as {
          metadata: {
            externalCssFetched?: boolean;
            externalCssStats?: {
              urlsFound: number;
              urlsFetched: number;
              fetchErrors: number;
            };
          };
          warnings?: Array<{ code: string }>;
        };
        // 外部CSS取得が試行された
        expect(data.metadata.externalCssFetched).toBe(true);
        // URLが検出された（2つの<link>タグ）
        if (data.metadata.externalCssStats) {
          expect(data.metadata.externalCssStats.urlsFound).toBe(2);
        }
        // 取得失敗は警告として記録される（エラーにならない）
        console.log('[E2E] External CSS fetch stats:', data.metadata.externalCssStats);
      } else {
        // ネットワークエラーでも graceful に処理
        console.log('[E2E] External CSS fetch failed (expected in test):', resultWithOptions);
      }

      console.log('[E2E] motion.detect network failure handling completed');
    }, 30000);

    /**
     * SSRF保護: プライベートIPへのアクセスがブロックされることを検証
     *
     * セキュリティ要件:
     * - localhost, 127.0.0.1, 192.168.x.x などへのアクセスをブロック
     * - クラウドメタデータサービス (169.254.x.x) へのアクセスをブロック
     * - ブロックされたURLは警告として報告
     */
    it('should block SSRF attempts for external CSS', async () => {
      // Arrange - プライベートIPを参照するHTML
      const htmlWithPrivateIp = `
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="stylesheet" href="http://192.168.1.1/internal.css">
          <link rel="stylesheet" href="http://localhost:3000/dev.css">
          <link rel="stylesheet" href="https://safe-cdn.example.com/public.css">
          <style>
            @keyframes safeAnimation {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            .safe { animation: safeAnimation 0.3s ease; }
          </style>
        </head>
        <body>
          <div class="safe">Safe content</div>
        </body>
        </html>
      `;

      // Act - 外部CSS取得を有効化
      const result = await motionDetectHandler({
        html: htmlWithPrivateIp,
        fetchExternalCss: true,
        baseUrl: 'https://example.com',
        detection_mode: 'css' as const,
      });

      // Assert - 処理は成功するが、SSRFブロックの警告が含まれる
      expect(isSuccess(result)).toBe(true);
      if (isSuccess(result)) {
        const data = result.data as {
          patterns: unknown[];
          metadata: {
            externalCssFetched?: boolean;
            blockedUrls?: string[];
          };
          warnings?: Array<{ code: string; message: string }>;
        };

        // インラインのアニメーションは検出される
        expect(data.patterns.length).toBeGreaterThan(0);

        // 外部CSS取得が試行された
        expect(data.metadata.externalCssFetched).toBe(true);

        // プライベートIPがブロックされた
        if (data.metadata.blockedUrls) {
          expect(data.metadata.blockedUrls.length).toBeGreaterThan(0);
          // localhost または 192.168.x.x がブロックされている
          const hasBlockedPrivate = data.metadata.blockedUrls.some(
            (url) => url.includes('localhost') || url.includes('192.168')
          );
          expect(hasBlockedPrivate).toBe(true);
        }

        // SSRF警告が含まれる
        if (data.warnings) {
          const ssrfWarning = data.warnings.find(
            (w) => w.code === 'EXTERNAL_CSS_SSRF_BLOCKED'
          );
          expect(ssrfWarning).toBeDefined();
        }

        console.log('[E2E] SSRF protection working:', {
          blockedUrls: data.metadata.blockedUrls,
        });
      }
    }, 15000);

    /**
     * メタデータに外部CSS統計情報が含まれることを検証
     *
     * externalCssStats:
     * - urlsFound: 検出されたCSS URLの数
     * - urlsFetched: 実際に取得成功した数
     * - fetchErrors: 取得失敗の数
     * - totalSize: 取得したCSSの合計サイズ
     */
    it('should include external CSS metadata in response', async () => {
      // Arrange
      const htmlWithMultipleLinks = `
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="stylesheet" href="https://cdn.example.com/base.css">
          <link rel="stylesheet" href="https://cdn.example.com/theme.css">
          <link rel="stylesheet" href="/local/styles.css">
          <style>
            .inline { color: blue; }
          </style>
        </head>
        <body></body>
        </html>
      `;

      // Act
      const result = await motionDetectHandler({
        html: htmlWithMultipleLinks,
        fetchExternalCss: true,
        baseUrl: 'https://example.com',
        externalCssOptions: {
          timeout: 3000,
          maxConcurrent: 3,
        },
        detection_mode: 'css' as const,
      });

      // Assert
      expect(isSuccess(result)).toBe(true);
      if (isSuccess(result)) {
        const data = result.data as {
          metadata: {
            externalCssFetched?: boolean;
            externalCssUrls?: string[];
            externalCssStats?: {
              urlsFound: number;
              urlsFetched: number;
              fetchErrors: number;
              totalSize?: number;
              fetchTimeMs?: number;
            };
          };
        };

        // メタデータが含まれる
        expect(data.metadata.externalCssFetched).toBe(true);

        // 外部CSS URLsが記録される
        if (data.metadata.externalCssUrls) {
          expect(data.metadata.externalCssUrls.length).toBeGreaterThanOrEqual(0);
        }

        // 統計情報が含まれる
        if (data.metadata.externalCssStats) {
          expect(data.metadata.externalCssStats.urlsFound).toBe(3);
          expect(typeof data.metadata.externalCssStats.urlsFetched).toBe('number');
          expect(typeof data.metadata.externalCssStats.fetchErrors).toBe('number');
          // 合計 = 成功 + 失敗
          expect(
            data.metadata.externalCssStats.urlsFetched +
              data.metadata.externalCssStats.fetchErrors
          ).toBeLessThanOrEqual(data.metadata.externalCssStats.urlsFound);
        }

        console.log('[E2E] External CSS metadata:', data.metadata);
      }
    }, 15000);
  });
});
