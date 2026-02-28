// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision CPU完走保証 E2Eテスト
 *
 * CPU環境でのVision分析完走を保証するための統合テスト。
 * Ollamaが起動していなくても、Graceful DegradationによりHTML分析にフォールバックして
 * テストが通過することを検証する。
 *
 * テスト対象:
 * 1. VisionFallbackService - Ollama未起動時のフォールバック動作
 * 2. ProgressReporter - 進捗コールバックの呼び出し検証
 * 3. タイムアウト設定とGraceful Degradation
 *
 * @see apps/mcp-server/src/services/vision/vision-fallback.service.ts
 * @see apps/mcp-server/src/services/vision/progress-reporter.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import {
  VisionFallbackService,
  type VisionFallbackOptions,
  type FallbackResult,
} from '../../src/services/vision/vision-fallback.service.js';
import {
  ProgressReporter,
  ProgressPhase,
  type ProgressEvent,
  type ProgressCallback,
} from '../../src/services/vision/progress-reporter.js';
import { SectionDetector, type DetectedSection } from '@reftrix/webdesign-core';

// =============================================================================
// テスト定数
// =============================================================================

/**
 * テスト用のBase64エンコードされた画像（1x1 透明PNG）
 */
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * テスト用HTMLコンテンツ（セクション検出可能な構造）
 */
const TEST_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
</head>
<body>
  <header role="banner">
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>

  <main>
    <section class="hero" role="main">
      <h1>Welcome to Reftrix</h1>
      <p>WebデザインをデータとしてRAG可能な形で集約するプラットフォーム</p>
      <button>Get Started</button>
    </section>

    <section class="features">
      <h2>Features</h2>
      <div class="feature-grid">
        <div class="feature-item">
          <h3>Layout Analysis</h3>
          <p>レイアウト構造を自動解析</p>
        </div>
        <div class="feature-item">
          <h3>Motion Detection</h3>
          <p>CSSアニメーションを検出</p>
        </div>
        <div class="feature-item">
          <h3>Quality Evaluation</h3>
          <p>デザイン品質を評価</p>
        </div>
      </div>
    </section>

    <section class="cta">
      <h2>Ready to Start?</h2>
      <p>今すぐ無料トライアルを始めましょう</p>
      <button>Sign Up Free</button>
    </section>
  </main>

  <footer role="contentinfo">
    <p>&copy; 2026 Reftrix. All rights reserved.</p>
  </footer>
</body>
</html>
`;

/**
 * ビジョン分析のモック結果
 */
const MOCK_VISION_RESULT = {
  result: 'Layout analysis complete. Detected hero section with heading and CTA button.',
  metrics: {
    processingTimeMs: 500,
    modelName: 'llama3.2-vision',
    optimizationApplied: false,
    originalSizeBytes: 1000,
    optimizedSizeBytes: 1000,
    hardwareType: 'cpu' as const,
    estimatedTimeoutMs: 60000,
  },
};

/**
 * 検出されたセクションのモックデータ
 */
const MOCK_DETECTED_SECTIONS: DetectedSection[] = [
  {
    type: 'hero',
    confidence: 0.95,
    element: {
      tagName: 'section',
      selector: 'section.hero',
      classes: ['hero'],
    },
    position: {
      startY: 0,
      endY: 400,
      height: 400,
      estimatedTop: 5,
    },
    content: {
      headings: ['Welcome to Reftrix'],
      paragraphs: ['WebデザインをデータとしてRAG可能な形で集約するプラットフォーム'],
      buttons: [{ text: 'Get Started', type: 'primary' }],
      links: [],
      images: [],
    },
    detectionMethod: 'class-name',
  },
  {
    type: 'feature',
    confidence: 0.85,
    element: {
      tagName: 'section',
      selector: 'section.features',
      classes: ['features'],
    },
    position: {
      startY: 400,
      endY: 800,
      height: 400,
      estimatedTop: 40,
    },
    content: {
      headings: ['Features', 'Layout Analysis', 'Motion Detection', 'Quality Evaluation'],
      paragraphs: ['レイアウト構造を自動解析', 'CSSアニメーションを検出', 'デザイン品質を評価'],
      buttons: [],
      links: [],
      images: [],
    },
    detectionMethod: 'class-name',
  },
];

// =============================================================================
// モック型定義
// =============================================================================

/**
 * LlamaVisionAdapterのモックインターフェース
 */
interface MockLlamaVisionAdapter {
  analyze: ReturnType<typeof vi.fn>;
  analyzeJSON: ReturnType<typeof vi.fn>;
  isAvailable: ReturnType<typeof vi.fn>;
}

/**
 * SectionDetectorのモックインターフェース
 */
interface MockSectionDetector {
  detect: ReturnType<typeof vi.fn>;
}

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * 利用可能なLlamaVisionAdapterモックを作成
 */
function createAvailableMockAdapter(): MockLlamaVisionAdapter {
  return {
    analyze: vi.fn().mockResolvedValue(MOCK_VISION_RESULT),
    analyzeJSON: vi.fn().mockResolvedValue({ result: {}, metrics: MOCK_VISION_RESULT.metrics }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/**
 * 利用不可能なLlamaVisionAdapterモックを作成（Ollama未起動をシミュレート）
 */
function createUnavailableMockAdapter(): MockLlamaVisionAdapter {
  return {
    analyze: vi.fn().mockRejectedValue(new Error('Ollama connection refused')),
    analyzeJSON: vi.fn().mockRejectedValue(new Error('Ollama connection refused')),
    isAvailable: vi.fn().mockResolvedValue(false),
  };
}

/**
 * タイムアウトするLlamaVisionAdapterモックを作成
 */
function createTimeoutMockAdapter(timeoutMs: number): MockLlamaVisionAdapter {
  return {
    analyze: vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs + 100));
      return MOCK_VISION_RESULT;
    }),
    analyzeJSON: vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs + 100));
      return { result: {}, metrics: MOCK_VISION_RESULT.metrics };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/**
 * SectionDetectorモックを作成
 */
function createMockSectionDetector(): MockSectionDetector {
  return {
    detect: vi.fn().mockResolvedValue(MOCK_DETECTED_SECTIONS),
  };
}

/**
 * エラーを返すSectionDetectorモックを作成
 */
function createErrorSectionDetector(): MockSectionDetector {
  return {
    detect: vi.fn().mockRejectedValue(new Error('Section detection failed')),
  };
}

// =============================================================================
// Vision CPU完走保証 E2Eテスト
// =============================================================================

describe('Vision CPU完走保証 E2E Tests', () => {
  // ===========================================================================
  // VisionFallbackService Graceful Degradationテスト
  // ===========================================================================

  describe('VisionFallbackService - Graceful Degradation', () => {
    describe('Strategy 1: Vision Timeout', () => {
      it('Visionタイムアウト時にHTML分析にフォールバックする', async () => {
        // Arrange: タイムアウトするVisionアダプターを設定
        const timeoutMs = 100; // 短いタイムアウト
        const mockAdapter = createTimeoutMockAdapter(timeoutMs);
        const mockDetector = createMockSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as unknown as Parameters<
            typeof VisionFallbackService.prototype['analyzeWithFallback']
          >[2] extends VisionFallbackOptions
            ? never
            : any,
          sectionDetector: mockDetector as unknown as SectionDetector,
          defaultTimeoutMs: timeoutMs,
        });

        // Act: フォールバック付き分析を実行
        const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {
          visionTimeoutMs: timeoutMs,
        });

        // Assert: フォールバック成功を検証
        expect(result.success).toBe(true);
        expect(result.visionUsed).toBe(false);
        expect(result.htmlAnalysisOnly).toBe(true);
        expect(result.fallbackReason).toMatch(/timeout/i);
        expect(result.metrics.visionTimedOut).toBe(true);
        expect(result.htmlAnalysis.sections).toHaveLength(MOCK_DETECTED_SECTIONS.length);
      });

      it('forceVision=true時はタイムアウトでエラーを返す', async () => {
        // Arrange
        const timeoutMs = 100;
        const mockAdapter = createTimeoutMockAdapter(timeoutMs);
        const mockDetector = createMockSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as any,
          sectionDetector: mockDetector as unknown as SectionDetector,
          defaultTimeoutMs: timeoutMs,
        });

        // Act
        const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {
          visionTimeoutMs: timeoutMs,
          forceVision: true,
        });

        // Assert: forceVision時はフォールバックせず失敗
        expect(result.success).toBe(false);
        expect(result.visionUsed).toBe(false);
        expect(result.htmlAnalysisOnly).toBe(false);
        // エラーメッセージは "forceVision is true but Vision analysis timed out"
        expect(result.fallbackReason).toMatch(/forceVision.*timed out/i);
      });
    });

    describe('Strategy 2: Vision Failure (Ollama未起動)', () => {
      it('Ollama未起動時にHTML分析にフォールバックする', async () => {
        // Arrange: 利用不可能なVisionアダプターを設定
        const mockAdapter = createUnavailableMockAdapter();
        const mockDetector = createMockSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as any,
          sectionDetector: mockDetector as unknown as SectionDetector,
        });

        // Act
        const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

        // Assert: Ollama未起動時のフォールバック成功を検証
        expect(result.success).toBe(true);
        expect(result.visionUsed).toBe(false);
        expect(result.htmlAnalysisOnly).toBe(true);
        expect(result.fallbackReason).toMatch(/not available/i);
        expect(result.htmlAnalysis.sections.length).toBeGreaterThan(0);
      });

      it('forceVision=true時はOllama未起動でエラーを返す', async () => {
        // Arrange
        const mockAdapter = createUnavailableMockAdapter();
        const mockDetector = createMockSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as any,
          sectionDetector: mockDetector as unknown as SectionDetector,
        });

        // Act
        const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {
          forceVision: true,
        });

        // Assert
        expect(result.success).toBe(false);
        expect(result.fallbackReason).toMatch(/forceVision.*not available/i);
      });

      it('VisionとHTML両方が失敗した場合は全体失敗を返す', async () => {
        // Arrange: 両方が失敗するモックを設定
        const mockAdapter = createUnavailableMockAdapter();
        const mockDetector = createErrorSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as any,
          sectionDetector: mockDetector as unknown as SectionDetector,
        });

        // Act
        const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

        // Assert: 両方失敗時はsuccess=false
        expect(result.success).toBe(false);
        expect(result.visionUsed).toBe(false);
        expect(result.htmlAnalysis.error).toBeTruthy();
      });
    });

    describe('Strategy 3: No Image', () => {
      it('画像なしの場合はHTML分析のみを実行（警告なし）', async () => {
        // Arrange
        const mockAdapter = createAvailableMockAdapter();
        const mockDetector = createMockSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as any,
          sectionDetector: mockDetector as unknown as SectionDetector,
        });

        // Act: 画像なしで分析
        const result = await service.analyzeWithFallback(undefined, TEST_HTML, {});

        // Assert: 画像なしは期待される動作（fallbackReasonなし）
        expect(result.success).toBe(true);
        expect(result.visionUsed).toBe(false);
        expect(result.htmlAnalysisOnly).toBe(true);
        expect(result.fallbackReason).toBeUndefined(); // 画像なしは警告なし
        expect(result.htmlAnalysis.sections.length).toBeGreaterThan(0);
      });

      it('空文字列の画像もHTML分析のみを実行', async () => {
        // Arrange
        const mockAdapter = createAvailableMockAdapter();
        const mockDetector = createMockSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as any,
          sectionDetector: mockDetector as unknown as SectionDetector,
        });

        // Act: 空文字列で分析
        const result = await service.analyzeWithFallback('', TEST_HTML, {});

        // Assert
        expect(result.success).toBe(true);
        expect(result.visionUsed).toBe(false);
        expect(result.htmlAnalysisOnly).toBe(true);
        expect(result.fallbackReason).toBeUndefined();
      });
    });

    describe('Success Case: Vision + HTML', () => {
      it('Vision利用可能時は両方の分析結果を返す', async () => {
        // Arrange: 利用可能なVisionアダプターを設定
        const mockAdapter = createAvailableMockAdapter();
        const mockDetector = createMockSectionDetector();

        const service = new VisionFallbackService({
          visionAdapter: mockAdapter as any,
          sectionDetector: mockDetector as unknown as SectionDetector,
        });

        // Act
        const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

        // Assert: Vision成功を検証
        expect(result.success).toBe(true);
        expect(result.visionUsed).toBe(true);
        expect(result.htmlAnalysisOnly).toBe(false);
        expect(result.visionAnalysis).toBeDefined();
        expect(result.visionAnalysis?.result).toBe(MOCK_VISION_RESULT.result);
        expect(result.htmlAnalysis.sections.length).toBeGreaterThan(0);
        expect(result.metrics.visionTimedOut).toBe(false);
        expect(result.metrics.visionAttemptTimeMs).toBeDefined();
      });
    });
  });

  // ===========================================================================
  // ProgressReporter統合テスト
  // ===========================================================================

  describe('ProgressReporter - 進捗コールバック', () => {
    let receivedEvents: ProgressEvent[];
    let progressCallback: ProgressCallback;

    beforeEach(() => {
      receivedEvents = [];
      progressCallback = vi.fn((event: ProgressEvent) => {
        receivedEvents.push({ ...event });
      });
    });

    describe('フェーズ遷移', () => {
      it('preparing → optimizing → analyzing → completing の順でフェーズが進む', () => {
        // Arrange
        const reporter = new ProgressReporter({
          onProgress: progressCallback,
          reportInterval: 60000, // 自動報告は無効化（テスト制御のため）
        });

        // Act: 各フェーズを手動で更新
        reporter.start(180000); // CPU推定時間 3分
        reporter.updatePhase('optimizing');
        reporter.updatePhase('analyzing');
        reporter.complete();

        // Assert: フェーズ順序を検証
        const phases = receivedEvents.map((e) => e.phase);
        expect(phases).toEqual(['preparing', 'optimizing', 'analyzing', 'completing']);
      });

      it('各フェーズで適切な進捗率範囲を報告する', () => {
        // Arrange
        const reporter = new ProgressReporter({
          onProgress: progressCallback,
          reportInterval: 60000,
        });

        // Act
        reporter.start(180000);
        reporter.updatePhase('optimizing');
        reporter.updatePhase('analyzing');
        reporter.complete();

        // Assert: 各フェーズの進捗率範囲を検証
        // preparing: 0-10%
        expect(receivedEvents[0].progress).toBeGreaterThanOrEqual(0);
        expect(receivedEvents[0].progress).toBeLessThanOrEqual(10);

        // optimizing: 10-30%
        expect(receivedEvents[1].progress).toBeGreaterThanOrEqual(10);
        expect(receivedEvents[1].progress).toBeLessThanOrEqual(30);

        // analyzing: 30-90%
        expect(receivedEvents[2].progress).toBeGreaterThanOrEqual(30);
        expect(receivedEvents[2].progress).toBeLessThanOrEqual(90);

        // completing: 100%
        expect(receivedEvents[3].progress).toBe(100);
      });
    });

    describe('推定残り時間', () => {
      it('開始時は推定合計時間に近い残り時間を報告する', () => {
        // Arrange
        const estimatedTotalMs = 180000; // 3分
        const reporter = new ProgressReporter({
          onProgress: progressCallback,
          reportInterval: 60000,
        });

        // Act
        reporter.start(estimatedTotalMs);

        // Assert: 開始直後は残り時間 ≈ 推定合計時間
        expect(receivedEvents[0].estimatedRemainingMs).toBeLessThanOrEqual(estimatedTotalMs);
        expect(receivedEvents[0].estimatedRemainingMs).toBeGreaterThan(0);
      });

      it('完了時は残り時間0を報告する', () => {
        // Arrange
        const reporter = new ProgressReporter({
          onProgress: progressCallback,
          reportInterval: 60000,
        });

        // Act
        reporter.start(180000);
        reporter.complete();

        // Assert
        const lastEvent = receivedEvents[receivedEvents.length - 1];
        expect(lastEvent.estimatedRemainingMs).toBe(0);
      });
    });

    describe('メッセージ', () => {
      it('各フェーズで意味のあるメッセージを報告する', () => {
        // Arrange
        const reporter = new ProgressReporter({
          onProgress: progressCallback,
          reportInterval: 60000,
        });

        // Act
        reporter.start(180000);
        reporter.updatePhase('optimizing');
        reporter.updatePhase('analyzing');
        reporter.complete();

        // Assert: 各フェーズのメッセージが非空であることを検証
        receivedEvents.forEach((event) => {
          expect(event.message).toBeTruthy();
          expect(event.message.length).toBeGreaterThan(0);
        });

        // 完了メッセージの検証
        const lastEvent = receivedEvents[receivedEvents.length - 1];
        expect(lastEvent.message).toMatch(/完了|complete/i);
      });
    });

    describe('コールバックエラーハンドリング', () => {
      it('コールバックがエラーをスローしても処理を継続する', () => {
        // Arrange
        const errorCallback = vi.fn(() => {
          throw new Error('Callback error');
        });

        const reporter = new ProgressReporter({
          onProgress: errorCallback,
          reportInterval: 60000,
        });

        // Act & Assert: エラーをスローしない
        expect(() => reporter.start(180000)).not.toThrow();
        expect(() => reporter.updatePhase('optimizing')).not.toThrow();
        expect(() => reporter.complete()).not.toThrow();
      });
    });

    describe('abort処理', () => {
      it('abort後はコールバックが呼ばれない', () => {
        // Arrange
        vi.useFakeTimers();
        const reporter = new ProgressReporter({
          onProgress: progressCallback,
          reportInterval: 1000, // 1秒ごと
        });

        try {
          // Act
          reporter.start(180000);
          const initialCallCount = (progressCallback as ReturnType<typeof vi.fn>).mock.calls.length;

          reporter.abort();

          // 時間を進める
          vi.advanceTimersByTime(5000);

          // Assert: abort後はコールバックが増えない
          const finalCallCount = (progressCallback as ReturnType<typeof vi.fn>).mock.calls.length;
          expect(finalCallCount).toBe(initialCallCount);
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  // ===========================================================================
  // 実際のSectionDetector統合テスト
  // ===========================================================================

  describe('SectionDetector統合 - 実HTML分析', () => {
    it('実際のSectionDetectorでHTML分析が成功する', async () => {
      // Arrange: 実際のSectionDetectorを使用
      const sectionDetector = new SectionDetector();

      const service = new VisionFallbackService({
        sectionDetector: sectionDetector,
        // Visionアダプターなし（HTML分析のみ）
      });

      // Act
      const result = await service.analyzeWithFallback(undefined, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
      expect(result.htmlAnalysis.sections.length).toBeGreaterThan(0);

      // 検出されたセクションの型を検証
      const sections = result.htmlAnalysis.sections;
      expect(sections.some((s) => s.type === 'hero')).toBe(true);
    });

    it('複雑なHTMLでも適切にセクションを検出する', async () => {
      // Arrange
      const complexHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <header role="banner">
            <nav role="navigation">Navigation</nav>
          </header>
          <main role="main">
            <section class="hero">
              <h1>Hero Title</h1>
            </section>
            <section class="features">
              <h2>Features</h2>
            </section>
            <section class="pricing">
              <h2>Pricing</h2>
            </section>
            <section class="testimonial">
              <h2>Testimonials</h2>
            </section>
            <section class="cta">
              <h2>CTA</h2>
              <button>Sign Up</button>
            </section>
          </main>
          <footer role="contentinfo">Footer</footer>
        </body>
        </html>
      `;

      const sectionDetector = new SectionDetector();
      const service = new VisionFallbackService({
        sectionDetector: sectionDetector,
      });

      // Act
      const result = await service.analyzeWithFallback(undefined, complexHtml, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.htmlAnalysis.sections.length).toBeGreaterThanOrEqual(3);

      // 各セクションタイプの検出を確認
      const types = result.htmlAnalysis.sections.map((s) => s.type);
      expect(types).toContain('hero');
    });
  });

  // ===========================================================================
  // メトリクス検証テスト
  // ===========================================================================

  describe('パフォーマンスメトリクス', () => {
    it('処理時間が正しく計測される', async () => {
      // Arrange
      const mockAdapter = createAvailableMockAdapter();
      const mockDetector = createMockSectionDetector();

      const service = new VisionFallbackService({
        visionAdapter: mockAdapter as any,
        sectionDetector: mockDetector as unknown as SectionDetector,
      });

      // Act
      const startTime = performance.now();
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});
      const endTime = performance.now();

      // Assert
      expect(result.metrics.totalTimeMs).toBeGreaterThan(0);
      expect(result.metrics.totalTimeMs).toBeLessThanOrEqual(endTime - startTime + 10); // 10msの余裕

      if (result.visionUsed) {
        expect(result.metrics.visionAttemptTimeMs).toBeGreaterThan(0);
      }
    });

    it('フォールバック時もメトリクスが正しく計測される', async () => {
      // Arrange
      const mockAdapter = createUnavailableMockAdapter();
      const mockDetector = createMockSectionDetector();

      const service = new VisionFallbackService({
        visionAdapter: mockAdapter as any,
        sectionDetector: mockDetector as unknown as SectionDetector,
      });

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.metrics.totalTimeMs).toBeGreaterThan(0);
      expect(result.metrics.visionTimedOut).toBe(false);
    });
  });

  // ===========================================================================
  // タイムアウト設定テスト
  // ===========================================================================

  describe('タイムアウト設定', () => {
    it('カスタムタイムアウト設定が適用される', async () => {
      // Arrange
      const customTimeoutMs = 50;
      const mockAdapter = createTimeoutMockAdapter(customTimeoutMs);
      const mockDetector = createMockSectionDetector();

      const service = new VisionFallbackService({
        visionAdapter: mockAdapter as any,
        sectionDetector: mockDetector as unknown as SectionDetector,
        defaultTimeoutMs: 30000, // デフォルト30秒
      });

      // Act: カスタムタイムアウトでフォールバック
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {
        visionTimeoutMs: customTimeoutMs,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.metrics.visionTimedOut).toBe(true);
    });

    it('デフォルトタイムアウトが使用される', async () => {
      // Arrange
      const defaultTimeoutMs = 50;
      const mockAdapter = createTimeoutMockAdapter(defaultTimeoutMs);
      const mockDetector = createMockSectionDetector();

      const service = new VisionFallbackService({
        visionAdapter: mockAdapter as any,
        sectionDetector: mockDetector as unknown as SectionDetector,
        defaultTimeoutMs: defaultTimeoutMs,
      });

      // Act: オプションでタイムアウト未指定
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert: デフォルトタイムアウトが適用される
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.metrics.visionTimedOut).toBe(true);
    });
  });

  // ===========================================================================
  // VisionアダプターなしのテストZZ
  // ===========================================================================

  describe('Visionアダプター未設定', () => {
    it('Visionアダプター未設定時はHTML分析のみ実行', async () => {
      // Arrange: Visionアダプターなしで作成
      const mockDetector = createMockSectionDetector();

      const service = new VisionFallbackService({
        sectionDetector: mockDetector as unknown as SectionDetector,
        // visionAdapter未設定
      });

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
      expect(result.fallbackReason).toMatch(/not configured/i);
    });

    it('forceVision=true + Visionアダプター未設定はエラー', async () => {
      // Arrange
      const mockDetector = createMockSectionDetector();

      const service = new VisionFallbackService({
        sectionDetector: mockDetector as unknown as SectionDetector,
      });

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {
        forceVision: true,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.fallbackReason).toMatch(/forceVision.*not configured/i);
    });
  });

  // ===========================================================================
  // SectionDetector未設定のテスト
  // ===========================================================================

  describe('SectionDetector未設定', () => {
    it('SectionDetector未設定時はエラーを返す', async () => {
      // Arrange
      const mockAdapter = createUnavailableMockAdapter();

      const service = new VisionFallbackService({
        visionAdapter: mockAdapter as any,
        // sectionDetector未設定
      });

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(false);
      expect(result.htmlAnalysis.error).toMatch(/not configured/i);
    });
  });
});

// =============================================================================
// ProgressPhase Enumテスト
// =============================================================================

describe('ProgressPhase Enum', () => {
  it('すべてのフェーズ値が定義されている', () => {
    expect(ProgressPhase.PREPARING).toBe('preparing');
    expect(ProgressPhase.OPTIMIZING).toBe('optimizing');
    expect(ProgressPhase.ANALYZING).toBe('analyzing');
    expect(ProgressPhase.COMPLETING).toBe('completing');
  });
});

// =============================================================================
// HardwareDetector + TimeoutCalculator 統合テスト
// =============================================================================

describe('HardwareDetector + TimeoutCalculator E2E統合', () => {
  describe('GPU環境シナリオ', () => {
    it('HardwareDetectorがGPUを検出した場合、60秒タイムアウトが設定される', async () => {
      // Arrange: HardwareDetector と TimeoutCalculator をインポート
      const { HardwareDetector, HardwareType } = await import(
        '../../src/services/vision/hardware-detector.js'
      );
      const { TimeoutCalculator, VisionTimeouts } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      // TimeoutCalculator は HardwareType.GPU に対して GPU タイムアウトを返す
      const calculator = new TimeoutCalculator();
      const timeout = calculator.calculate(HardwareType.GPU, 200_000); // 200KB画像

      // Assert: GPUは画像サイズに関係なく60秒
      expect(timeout).toBe(VisionTimeouts.GPU);
      expect(timeout).toBe(60_000);
    });

    it('GPU検出時は画像サイズに関係なく一定のタイムアウト', async () => {
      const { HardwareType } = await import('../../src/services/vision/hardware-detector.js');
      const { TimeoutCalculator, VisionTimeouts } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      const calculator = new TimeoutCalculator();

      // 小画像、中画像、大画像すべてで同じタイムアウト
      expect(calculator.calculate(HardwareType.GPU, 50_000)).toBe(VisionTimeouts.GPU);
      expect(calculator.calculate(HardwareType.GPU, 200_000)).toBe(VisionTimeouts.GPU);
      expect(calculator.calculate(HardwareType.GPU, 600_000)).toBe(VisionTimeouts.GPU);
    });
  });

  describe('CPU環境シナリオ - 画像サイズ別タイムアウト', () => {
    it('SMALL (<100KB): 180秒タイムアウト', async () => {
      const { HardwareType } = await import('../../src/services/vision/hardware-detector.js');
      const { TimeoutCalculator, VisionTimeouts, ImageSize } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      const calculator = new TimeoutCalculator();

      // 小画像（100KB未満）
      const smallImageSizes = [50_000, 80_000, 99_999];

      for (const size of smallImageSizes) {
        const timeout = calculator.calculate(HardwareType.CPU, size);
        expect(timeout).toBe(VisionTimeouts.CPU_SMALL);
        expect(timeout).toBe(180_000); // 3分

        // 画像サイズ分類も確認
        expect(calculator.classifyImageSize(size)).toBe(ImageSize.SMALL);
      }
    });

    it('MEDIUM (100KB-500KB): 600秒タイムアウト', async () => {
      const { HardwareType } = await import('../../src/services/vision/hardware-detector.js');
      const { TimeoutCalculator, VisionTimeouts, ImageSize } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      const calculator = new TimeoutCalculator();

      // 中画像（100KB以上500KB未満）
      const mediumImageSizes = [100_000, 250_000, 400_000, 499_999];

      for (const size of mediumImageSizes) {
        const timeout = calculator.calculate(HardwareType.CPU, size);
        expect(timeout).toBe(VisionTimeouts.CPU_MEDIUM);
        expect(timeout).toBe(600_000); // 10分

        // 画像サイズ分類も確認
        expect(calculator.classifyImageSize(size)).toBe(ImageSize.MEDIUM);
      }
    });

    it('LARGE (>=500KB): 1200秒タイムアウト', async () => {
      const { HardwareType } = await import('../../src/services/vision/hardware-detector.js');
      const { TimeoutCalculator, VisionTimeouts, ImageSize } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      const calculator = new TimeoutCalculator();

      // 大画像（500KB以上）
      const largeImageSizes = [500_000, 1_000_000, 5_000_000];

      for (const size of largeImageSizes) {
        const timeout = calculator.calculate(HardwareType.CPU, size);
        expect(timeout).toBe(VisionTimeouts.CPU_LARGE);
        expect(timeout).toBe(1_200_000); // 20分

        // 画像サイズ分類も確認
        expect(calculator.classifyImageSize(size)).toBe(ImageSize.LARGE);
      }
    });

    it('画像サイズ未指定時はMEDIUMとして扱う', async () => {
      const { HardwareType } = await import('../../src/services/vision/hardware-detector.js');
      const { TimeoutCalculator, VisionTimeouts, ImageSize } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      const calculator = new TimeoutCalculator();

      // undefined の場合
      const timeout = calculator.calculate(HardwareType.CPU, undefined);
      expect(timeout).toBe(VisionTimeouts.CPU_MEDIUM);

      // classifyImageSizeでも確認
      expect(calculator.classifyImageSize(undefined)).toBe(ImageSize.MEDIUM);
    });

    it('タイムアウトのフォーマット表示が正しい', async () => {
      const { TimeoutCalculator, VisionTimeouts } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      const calculator = new TimeoutCalculator();

      // 各タイムアウト値のフォーマット確認
      expect(calculator.formatTimeout(VisionTimeouts.GPU)).toBe('1m 0s');
      expect(calculator.formatTimeout(VisionTimeouts.CPU_SMALL)).toBe('3m 0s');
      expect(calculator.formatTimeout(VisionTimeouts.CPU_MEDIUM)).toBe('10m 0s');
      expect(calculator.formatTimeout(VisionTimeouts.CPU_LARGE)).toBe('20m 0s');
    });
  });

  describe('Graceful Degradation - Ollama接続失敗時のCPUフォールバック', () => {
    it('Ollama未起動時はCPUフォールバックしエラーメッセージを含む', async () => {
      const { HardwareDetector, HardwareType } = await import(
        '../../src/services/vision/hardware-detector.js'
      );

      // Ollama未起動をシミュレート（存在しないURLを指定）
      const detector = new HardwareDetector({
        ollamaUrl: 'http://localhost:99999', // 存在しないポート
      });

      const result = await detector.detect();

      // CPUフォールバックを確認
      expect(result.type).toBe(HardwareType.CPU);
      expect(result.isGpuAvailable).toBe(false);
      expect(result.vramBytes).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/connection|failed|refused/i);
    });

    it('Ollamaエラー時もCPUフォールバックで処理が継続する', async () => {
      const { HardwareDetector, HardwareType } = await import(
        '../../src/services/vision/hardware-detector.js'
      );
      const { TimeoutCalculator, VisionTimeouts } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      // Ollama未起動をシミュレート
      const detector = new HardwareDetector({
        ollamaUrl: 'http://localhost:99999',
      });

      const hardwareInfo = await detector.detect();
      const calculator = new TimeoutCalculator();

      // CPUフォールバック後のタイムアウト計算
      const timeout = calculator.calculateFromHardwareInfo(hardwareInfo, 300_000); // 300KB画像

      // CPUとして処理され、適切なタイムアウトが設定される
      expect(hardwareInfo.type).toBe(HardwareType.CPU);
      expect(timeout).toBe(VisionTimeouts.CPU_MEDIUM);
    });
  });
});

// =============================================================================
// MCPProgressAdapter 統合テスト
// =============================================================================

describe('MCPProgressAdapter E2E統合', () => {
  describe('MCP notifications/progress 送信', () => {
    it('ProgressReporterとMCPProgressAdapterの連携が正しく動作する', async () => {
      const { ProgressReporter } = await import(
        '../../src/services/vision/progress-reporter.js'
      );
      const { createMCPProgressCallback } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      // MCP sendNotification のモック
      const sentNotifications: Array<{
        method: string;
        params: { progressToken: string | number; progress: number; total?: number; message?: string };
      }> = [];

      const mockSendNotification = vi.fn(async (notification) => {
        sentNotifications.push(notification);
      });

      // MCPProgressCallback を作成
      const progressCallback = createMCPProgressCallback({
        progressToken: 'test-token-123',
        sendNotification: mockSendNotification,
      });

      expect(progressCallback).not.toBeNull();

      // ProgressReporter を作成して連携
      const reporter = new ProgressReporter({
        onProgress: progressCallback!,
        reportInterval: 60000, // 自動報告は無効化
      });

      // 進捗報告を実行
      reporter.start(180000);
      reporter.updatePhase('optimizing');
      reporter.updatePhase('analyzing');
      reporter.complete();

      // 通知が送信されたことを確認
      expect(mockSendNotification).toHaveBeenCalled();
      expect(sentNotifications.length).toBeGreaterThanOrEqual(4); // start + 3 updates

      // 各通知の形式を検証
      for (const notification of sentNotifications) {
        expect(notification.method).toBe('notifications/progress');
        expect(notification.params.progressToken).toBe('test-token-123');
        expect(notification.params.progress).toBeGreaterThanOrEqual(0);
        expect(notification.params.progress).toBeLessThanOrEqual(100);
        expect(notification.params.total).toBe(100);
        expect(notification.params.message).toBeDefined();
      }

      // 最後の通知は完了（100%）であること
      const lastNotification = sentNotifications[sentNotifications.length - 1];
      expect(lastNotification.params.progress).toBe(100);
    });

    it('progressTokenが未定義の場合はnullを返す', async () => {
      const { createMCPProgressCallback } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const callback = createMCPProgressCallback({
        progressToken: undefined,
        sendNotification: vi.fn(),
      });

      expect(callback).toBeNull();
    });

    it('sendNotificationが未定義の場合はnullを返す', async () => {
      const { createMCPProgressCallback } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const callback = createMCPProgressCallback({
        progressToken: 'test-token',
        sendNotification: undefined,
      });

      expect(callback).toBeNull();
    });

    it('MCPProgressAdapterはprogressTokenを保持する', async () => {
      const { MCPProgressAdapter } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const adapter = new MCPProgressAdapter({
        progressToken: 'my-progress-token',
        sendNotification: vi.fn(),
      });

      expect(adapter.getProgressToken()).toBe('my-progress-token');
      expect(adapter.isEnabled()).toBe(true);
    });

    it('数値のprogressTokenもサポートする', async () => {
      const { MCPProgressAdapter } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const sentNotifications: unknown[] = [];
      const mockSendNotification = vi.fn(async (notification) => {
        sentNotifications.push(notification);
      });

      const adapter = new MCPProgressAdapter({
        progressToken: 12345, // 数値トークン
        sendNotification: mockSendNotification,
      });

      expect(adapter.getProgressToken()).toBe(12345);

      // 進捗送信
      await adapter.sendProgress({
        phase: 'analyzing',
        progress: 50,
        estimatedRemainingMs: 90000,
        message: 'Analyzing...',
      });

      // 通知を確認
      expect(sentNotifications.length).toBe(1);
      expect((sentNotifications[0] as any).params.progressToken).toBe(12345);
    });
  });

  describe('Graceful Degradation - 進捗送信失敗時', () => {
    it('sendNotificationがエラーをスローしても処理が継続する', async () => {
      const { MCPProgressAdapter } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const errorSendNotification = vi.fn(async () => {
        throw new Error('Network error');
      });

      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: errorSendNotification,
      });

      // エラーをスローしないことを確認
      await expect(
        adapter.sendProgress({
          phase: 'analyzing',
          progress: 50,
          estimatedRemainingMs: 90000,
          message: 'Analyzing...',
        })
      ).resolves.not.toThrow();

      // sendNotificationは呼ばれたが、エラーは内部で処理された
      expect(errorSendNotification).toHaveBeenCalled();
    });

    it('createMCPProgressCallbackのコールバックもエラーを伝播しない', async () => {
      const { createMCPProgressCallback } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const errorSendNotification = vi.fn(async () => {
        throw new Error('Callback error');
      });

      const callback = createMCPProgressCallback({
        progressToken: 'test-token',
        sendNotification: errorSendNotification,
      });

      // コールバックはfire-and-forgetなのでエラーは伝播しない
      expect(() => {
        callback!({
          phase: 'analyzing',
          progress: 50,
          estimatedRemainingMs: 90000,
          message: 'Test',
        });
      }).not.toThrow();
    });
  });

  describe('進捗メッセージのフォーマット', () => {
    it('フェーズ情報を含むメッセージが正しくフォーマットされる', async () => {
      const { MCPProgressAdapter } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const sentNotifications: unknown[] = [];
      const mockSendNotification = vi.fn(async (notification) => {
        sentNotifications.push(notification);
      });

      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      // フェーズ情報を含まないメッセージ
      await adapter.sendProgress({
        phase: 'analyzing',
        progress: 50,
        estimatedRemainingMs: 90000,
        message: '処理中です',
      });

      // メッセージにフェーズが付加される
      expect(sentNotifications.length).toBe(1);
      expect((sentNotifications[0] as any).params.message).toMatch(/\[analyzing\]/);
    });

    it('既にフェーズ情報を含むメッセージはそのまま使用される', async () => {
      const { MCPProgressAdapter } = await import(
        '../../src/services/vision/mcp-progress-adapter.js'
      );

      const sentNotifications: unknown[] = [];
      const mockSendNotification = vi.fn(async (notification) => {
        sentNotifications.push(notification);
      });

      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      // 既にフェーズを含むメッセージ
      await adapter.sendProgress({
        phase: 'analyzing',
        progress: 50,
        estimatedRemainingMs: 90000,
        message: 'analyzing phase: 処理中',
      });

      // メッセージはそのまま
      expect(sentNotifications.length).toBe(1);
      expect((sentNotifications[0] as any).params.message).toBe('analyzing phase: 処理中');
    });
  });
});

// =============================================================================
// VisionFallbackService + HardwareDetector + TimeoutCalculator 完全統合テスト
// =============================================================================

describe('Vision CPU完走保証 完全統合E2Eテスト', () => {
  describe('CPU環境での完走保証', () => {
    it('Ollama未起動時でもHTML分析にフォールバックして成功を返す', async () => {
      const { VisionFallbackService } = await import(
        '../../src/services/vision/vision-fallback.service.js'
      );
      const { SectionDetector } = await import('@reftrix/webdesign-core');

      // 実際のSectionDetectorを使用（HTML分析のみ）
      const sectionDetector = new SectionDetector();

      const service = new VisionFallbackService({
        sectionDetector: sectionDetector,
        // Visionアダプターなし（Ollama未起動をシミュレート）
      });

      // CPU完走保証: Vision使用不可でもHTML分析で成功
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
      expect(result.htmlAnalysis.sections.length).toBeGreaterThan(0);
      expect(result.metrics.totalTimeMs).toBeGreaterThan(0);
    });

    it('大画像でのCPU処理時にも適切なタイムアウトが設定される', async () => {
      const { HardwareType } = await import('../../src/services/vision/hardware-detector.js');
      const { TimeoutCalculator, VisionTimeouts } = await import(
        '../../src/services/vision/timeout-calculator.js'
      );

      const calculator = new TimeoutCalculator();

      // フルページスクリーンショット（500KB以上）のシナリオ
      const fullPageImageSize = 800_000; // 800KB
      const timeout = calculator.calculate(HardwareType.CPU, fullPageImageSize);

      // 20分のタイムアウトが設定される
      expect(timeout).toBe(VisionTimeouts.CPU_LARGE);
      expect(timeout).toBe(1_200_000);

      // フォーマット確認
      expect(calculator.formatTimeout(timeout)).toBe('20m 0s');
    });
  });

  describe('進捗報告統合', () => {
    it('長時間処理での進捗報告が正しく動作する', async () => {
      const { ProgressReporter, ProgressPhase } = await import(
        '../../src/services/vision/progress-reporter.js'
      );

      const events: Array<{ phase: string; progress: number; message: string }> = [];
      const reporter = new ProgressReporter({
        onProgress: (event) => {
          events.push({
            phase: event.phase,
            progress: event.progress,
            message: event.message,
          });
        },
        reportInterval: 60000, // 自動報告無効化
      });

      // CPU Large のタイムアウト（20分）をシミュレート
      reporter.start(1_200_000);

      // 各フェーズを手動で更新
      reporter.updatePhase(ProgressPhase.OPTIMIZING);
      reporter.updatePhase(ProgressPhase.ANALYZING);
      reporter.complete();

      // 4つのイベントが発生
      expect(events.length).toBe(4);

      // 進捗が単調増加
      for (let i = 1; i < events.length; i++) {
        expect(events[i].progress).toBeGreaterThanOrEqual(events[i - 1].progress);
      }

      // 最後は100%
      expect(events[events.length - 1].progress).toBe(100);
    });
  });
});
