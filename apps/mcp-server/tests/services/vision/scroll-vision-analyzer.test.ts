// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScrollVisionAnalyzer テスト
 *
 * スクロール位置スクリーンショットのVision分析サービスのユニットテスト
 *
 * テスト対象:
 * - 正常系: Visionで各キャプチャを分析
 * - Ollama未接続時のgraceful degradation
 * - 無効なVisionレスポンスのハンドリング
 * - scrollTriggeredAnimationsの集約
 * - 順次処理の検証
 *
 * @module tests/services/vision/scroll-vision-analyzer.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// OllamaVisionClient モック
const mockIsAvailable = vi.fn().mockResolvedValue(true);
const mockGenerateJSON = vi.fn();

vi.mock('../../../src/services/vision/ollama-vision-client.js', () => {
  return {
    OllamaVisionClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.isAvailable = mockIsAvailable;
      this.generateJSON = mockGenerateJSON;
      return this;
    }),
  };
});

// Logger モック
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  analyzeScrollCaptures,
  type ScrollVisionResult,
} from '../../../src/services/vision/scroll-vision.analyzer.js';
import type { ScrollCapture } from '../../../src/services/vision/scroll-vision-capture.service.js';

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * テスト用ScrollCaptureを生成
 */
function createTestCapture(overrides?: Partial<ScrollCapture>): ScrollCapture {
  return {
    scrollY: 0,
    sectionIndex: 0,
    screenshot: Buffer.from('fake-screenshot-data'),
    viewportHeight: 900,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * 正常なVisionレスポンスを生成
 */
function createValidVisionResponse(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    scrollTriggeredElements: [
      {
        element: 'Hero section fade-in animation',
        changeType: 'appear',
        confidence: 0.85,
      },
    ],
    visualImpression: 'Professional landing page with hero section',
    confidence: 0.9,
    ...overrides,
  };
}

// =============================================================================
// analyzeScrollCaptures テスト
// =============================================================================

describe('analyzeScrollCaptures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAvailable.mockResolvedValue(true);
    mockGenerateJSON.mockResolvedValue(createValidVisionResponse());
  });

  // ---------------------------------------------------------------------------
  // 正常系
  // ---------------------------------------------------------------------------

  describe('正常系', () => {
    it('各キャプチャに対してVision分析を実行する', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0, sectionIndex: 0 }),
        createTestCapture({ scrollY: 500, sectionIndex: 1 }),
        createTestCapture({ scrollY: 1000, sectionIndex: 2 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(mockGenerateJSON).toHaveBeenCalledTimes(3);
      expect(result.analyzedCount).toBe(3);
      expect(result.captureCount).toBe(3);
    });

    it('分析結果にscrollYとsectionIndexが含まれる', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 500, sectionIndex: 2 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.analyses.length).toBe(1);
      expect(result.analyses[0]?.scrollY).toBe(500);
      expect(result.analyses[0]?.sectionIndex).toBe(2);
    });

    it('scrollTriggeredElementsが正しく含まれる', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0, sectionIndex: 0 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      const analysis = result.analyses[0];
      expect(analysis?.scrollTriggeredElements.length).toBe(1);
      expect(analysis?.scrollTriggeredElements[0]?.element).toContain('Hero section');
      expect(analysis?.scrollTriggeredElements[0]?.changeType).toBe('appear');
      expect(analysis?.scrollTriggeredElements[0]?.confidence).toBe(0.85);
    });

    it('visualImpressionが含まれる', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0, sectionIndex: 0 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.analyses[0]?.visualImpression).toContain('Professional landing page');
    });

    it('visionModelUsedが正しいモデル名を返す', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.visionModelUsed).toBe('llama3.2-vision');
    });

    it('カスタムモデル名が反映される', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures, {
        model: 'llava-v1.6',
      });

      expect(result.visionModelUsed).toBe('llava-v1.6');
    });

    it('processingTimeMsが計測される', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.totalProcessingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.analyses[0]?.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('Base64エンコードされたスクリーンショットがVisionに渡される', async () => {
      const screenshotData = Buffer.from('test-image-data');
      const captures: ScrollCapture[] = [
        createTestCapture({ screenshot: screenshotData }),
      ];

      await analyzeScrollCaptures(captures);

      expect(mockGenerateJSON).toHaveBeenCalledWith(
        screenshotData.toString('base64'),
        expect.stringContaining('scroll position')
      );
    });

    it('プロンプトにスクロール位置が含まれる', async () => {
      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 1234 }),
      ];

      await analyzeScrollCaptures(captures);

      expect(mockGenerateJSON).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('1234px')
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------

  describe('Ollama未接続時のgraceful degradation', () => {
    it('Ollama未接続時は空の結果を返す', async () => {
      mockIsAvailable.mockResolvedValue(false);

      const captures: ScrollCapture[] = [
        createTestCapture(),
        createTestCapture({ scrollY: 500 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.analyzedCount).toBe(0);
      expect(result.captureCount).toBe(2);
      expect(result.analyses).toEqual([]);
      expect(result.scrollTriggeredAnimations).toEqual([]);
    });

    it('Ollama未接続時にVision APIが呼ばれない', async () => {
      mockIsAvailable.mockResolvedValue(false);

      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      await analyzeScrollCaptures(captures);

      expect(mockGenerateJSON).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // エラーハンドリング
  // ---------------------------------------------------------------------------

  describe('エラーハンドリング', () => {
    it('個別キャプチャのVisionエラーは全体を中断しない', async () => {
      mockGenerateJSON
        .mockResolvedValueOnce(createValidVisionResponse())
        .mockRejectedValueOnce(new Error('Vision timeout'))
        .mockResolvedValueOnce(createValidVisionResponse());

      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0, sectionIndex: 0 }),
        createTestCapture({ scrollY: 500, sectionIndex: 1 }),
        createTestCapture({ scrollY: 1000, sectionIndex: 2 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      // 3つ中2つが成功
      expect(result.analyzedCount).toBe(2);
      expect(result.captureCount).toBe(3);
    });

    it('無効なJSONレスポンスはスキップされる', async () => {
      mockGenerateJSON.mockResolvedValue('not-an-object');

      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures);

      // バリデーション失敗でnullが返されるため、analyzedCountは0
      expect(result.analyzedCount).toBe(0);
    });

    it('不完全なJSONレスポンスはデフォルト値で補完される', async () => {
      // scrollTriggeredElementsが空、他フィールドのみ
      mockGenerateJSON.mockResolvedValue({
        visualImpression: 'A simple page',
        confidence: 0.7,
      });

      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.analyzedCount).toBe(1);
      expect(result.analyses[0]?.scrollTriggeredElements).toEqual([]);
    });

    it('confidence < 0.3の要素はフィルタリングされる', async () => {
      mockGenerateJSON.mockResolvedValue({
        scrollTriggeredElements: [
          { element: 'High confidence', changeType: 'appear', confidence: 0.9 },
          { element: 'Low confidence', changeType: 'animate', confidence: 0.1 },
        ],
        visualImpression: 'Test page',
        confidence: 0.8,
      });

      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.analyses[0]?.scrollTriggeredElements.length).toBe(1);
      expect(result.analyses[0]?.scrollTriggeredElements[0]?.element).toContain('High confidence');
    });

    it('全キャプチャがエラーでも結果構造は正常', async () => {
      mockGenerateJSON.mockRejectedValue(new Error('Ollama crashed'));

      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0 }),
        createTestCapture({ scrollY: 500 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.analyzedCount).toBe(0);
      expect(result.captureCount).toBe(2);
      expect(result.analyses).toEqual([]);
      expect(result.scrollTriggeredAnimations).toEqual([]);
      expect(result.totalProcessingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 集約
  // ---------------------------------------------------------------------------

  describe('scrollTriggeredAnimationsの集約', () => {
    it('全分析結果からスクロールトリガーアニメーションを集約する', async () => {
      mockGenerateJSON
        .mockResolvedValueOnce({
          scrollTriggeredElements: [
            { element: 'Hero fade-in', changeType: 'appear', confidence: 0.9 },
          ],
          visualImpression: 'Hero section',
          confidence: 0.85,
        })
        .mockResolvedValueOnce({
          scrollTriggeredElements: [
            { element: 'Feature slide-in', changeType: 'animate', confidence: 0.8 },
            { element: 'Parallax background', changeType: 'parallax', confidence: 0.7 },
          ],
          visualImpression: 'Feature section',
          confidence: 0.8,
        });

      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0, sectionIndex: 0 }),
        createTestCapture({ scrollY: 1000, sectionIndex: 1 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.scrollTriggeredAnimations.length).toBe(3);
    });

    it('集約結果はconfidenceで降順ソートされる', async () => {
      mockGenerateJSON
        .mockResolvedValueOnce({
          scrollTriggeredElements: [
            { element: 'Low conf', changeType: 'appear', confidence: 0.5 },
          ],
          visualImpression: 'Section 1',
          confidence: 0.7,
        })
        .mockResolvedValueOnce({
          scrollTriggeredElements: [
            { element: 'High conf', changeType: 'animate', confidence: 0.95 },
          ],
          visualImpression: 'Section 2',
          confidence: 0.9,
        });

      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0, sectionIndex: 0 }),
        createTestCapture({ scrollY: 1000, sectionIndex: 1 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.scrollTriggeredAnimations[0]?.confidence).toBe(0.95);
      expect(result.scrollTriggeredAnimations[1]?.confidence).toBe(0.5);
    });

    it('集約結果にtriggerScrollYが含まれる', async () => {
      mockGenerateJSON.mockResolvedValue({
        scrollTriggeredElements: [
          { element: 'Test element', changeType: 'appear', confidence: 0.8 },
        ],
        visualImpression: 'Test',
        confidence: 0.8,
      });

      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 750, sectionIndex: 2 }),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.scrollTriggeredAnimations[0]?.triggerScrollY).toBe(750);
      expect(result.scrollTriggeredAnimations[0]?.animationType).toBe('appear');
    });

    it('低信頼度の要素は集約からも除外される', async () => {
      mockGenerateJSON.mockResolvedValue({
        scrollTriggeredElements: [
          { element: 'Maybe parallax', changeType: 'parallax', confidence: 0.1 },
        ],
        visualImpression: 'Test',
        confidence: 0.5,
      });

      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures);

      expect(result.scrollTriggeredAnimations.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 順次処理の検証
  // ---------------------------------------------------------------------------

  describe('順次処理', () => {
    it('キャプチャは順次処理される（並列ではない）', async () => {
      const callOrder: number[] = [];

      mockGenerateJSON.mockImplementation(async () => {
        const index = callOrder.length;
        callOrder.push(index);
        // 短い遅延を入れて順序を確認
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return createValidVisionResponse();
      });

      const captures: ScrollCapture[] = [
        createTestCapture({ scrollY: 0, sectionIndex: 0 }),
        createTestCapture({ scrollY: 500, sectionIndex: 1 }),
        createTestCapture({ scrollY: 1000, sectionIndex: 2 }),
      ];

      await analyzeScrollCaptures(captures);

      // 順次実行されるため、callOrderは [0, 1, 2] になる
      expect(callOrder).toEqual([0, 1, 2]);
    });
  });

  // ---------------------------------------------------------------------------
  // XSSサニタイズ
  // ---------------------------------------------------------------------------

  describe('XSSサニタイズ', () => {
    it('Vision結果のHTML要素はサニタイズされる', async () => {
      mockGenerateJSON.mockResolvedValue({
        scrollTriggeredElements: [
          {
            element: '<script>alert("xss")</script>Hero section',
            changeType: 'appear',
            confidence: 0.8,
          },
        ],
        visualImpression: '<img onerror="alert(1)">Landing page',
        confidence: 0.8,
      });

      const captures: ScrollCapture[] = [
        createTestCapture(),
      ];

      const result = await analyzeScrollCaptures(captures);

      const analysis = result.analyses[0];
      expect(analysis?.scrollTriggeredElements[0]?.element).not.toContain('<script>');
      expect(analysis?.visualImpression).not.toContain('<img');
    });
  });

  // ---------------------------------------------------------------------------
  // 空入力
  // ---------------------------------------------------------------------------

  describe('空入力', () => {
    it('空のキャプチャ配列では分析をスキップする', async () => {
      const result = await analyzeScrollCaptures([]);

      expect(result.analyzedCount).toBe(0);
      expect(result.captureCount).toBe(0);
      expect(result.analyses).toEqual([]);
      expect(result.scrollTriggeredAnimations).toEqual([]);
      // isAvailableは呼ばれるが、generateJSONは呼ばれない
      expect(mockGenerateJSON).not.toHaveBeenCalled();
    });
  });
});
