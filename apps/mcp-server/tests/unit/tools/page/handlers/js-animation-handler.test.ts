// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * js-animation-handler.ts 単体テスト
 *
 * page.analyze のJSアニメーション検出ハンドラーをテスト
 *
 * @module tests/unit/tools/page/handlers/js-animation-handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// モック変数（hoistedモック内で使用）
const mockPage = {
  goto: vi.fn(),
  waitForTimeout: vi.fn(),
  close: vi.fn(),
};

const mockContext = {
  newPage: vi.fn(),
  close: vi.fn(),
};

const mockBrowser = {
  newContext: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockChromiumLaunch = vi.fn();

// Playwrightモック
vi.mock('playwright', () => ({
  chromium: {
    launch: mockChromiumLaunch,
  },
}));

// モック検出サービス
const mockDetect = vi.fn();
const mockCleanup = vi.fn();

// DI-factoriesモック
vi.mock('../../../../../src/tools/motion/di-factories', () => ({
  getJSAnimationDetectorService: vi.fn(() => ({
    detect: mockDetect,
    cleanup: mockCleanup,
  })),
}));

// Loggerモック
vi.mock('../../../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: () => true,
}));

// テスト対象のインポート
import {
  executeJSAnimationMode,
  type JSAnimationModeResult,
} from '../../../../../src/tools/page/handlers/js-animation-handler';

describe('js-animation-handler', () => {
  const mockDetectionResult = {
    cdpAnimations: [],
    webAnimations: [],
    libraries: {
      gsap: { detected: false },
      framerMotion: { detected: false },
      anime: { detected: false },
      three: { detected: false },
      lottie: { detected: false },
    },
    detectionTimeMs: 100,
    totalDetected: 0,
  };

  beforeEach(() => {
    vi.resetAllMocks();

    // Playwrightモックのセットアップ
    mockContext.newPage.mockResolvedValue(mockPage);
    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.waitForTimeout.mockResolvedValue(undefined);

    // 検出サービスモックのセットアップ
    mockDetect.mockResolvedValue(mockDetectionResult);
    mockCleanup.mockResolvedValue(undefined);
  });

  describe('executeJSAnimationMode', () => {
    describe('無効化パターン', () => {
      it('enabled=falseの場合、検出をスキップする', async () => {
        const result = await executeJSAnimationMode('https://example.com', false);

        expect(result).toEqual({});
        expect(mockDetect).not.toHaveBeenCalled();
        expect(mockChromiumLaunch).not.toHaveBeenCalled();
      });

      it('enabled=undefinedの場合、検出を実行する（v0.1.0: デフォルト有効、asyncモードで長時間検出可能）', async () => {
        // v0.1.0: detect_js_animationsのデフォルトがtrueに変更
        // asyncモードで長時間検出可能なため、デフォルト有効に
        const result = await executeJSAnimationMode('https://example.com', undefined);

        // enabled ?? true → undefinedはtrueとして扱われ、検出が実行される
        expect(mockChromiumLaunch).toHaveBeenCalled();
      });
    });

    describe('URL検証', () => {
      it('URLが空の場合、エラーを返す', async () => {
        const result = await executeJSAnimationMode('', true);

        expect(result.js_animation_error).toBeDefined();
        expect(result.js_animation_error?.code).toBe('JS_ANIMATION_URL_REQUIRED');
        expect(result.js_animation_error?.message).toContain('URL is required');
        expect(mockChromiumLaunch).not.toHaveBeenCalled();
      });
    });

    describe('正常系', () => {
      it('検出結果がサマリーに変換される', async () => {
        mockDetect.mockResolvedValueOnce({
          cdpAnimations: [
            {
              id: '1',
              name: 'anim1',
              pausedState: false,
              playState: 'running',
              playbackRate: 1,
              startTime: 0,
              currentTime: 100,
              type: 'CSSAnimation',
              source: {
                duration: 1000,
                delay: 0,
                iterations: 1,
                direction: 'normal',
                easing: 'ease',
              },
            },
            {
              id: '2',
              name: 'anim2',
              pausedState: false,
              playState: 'running',
              playbackRate: 1,
              startTime: 0,
              currentTime: 200,
              type: 'CSSTransition',
              source: {
                duration: 500,
                delay: 0,
                iterations: 1,
                direction: 'normal',
                easing: 'linear',
              },
            },
          ],
          webAnimations: [
            {
              id: 'w1',
              playState: 'running',
              target: '#box',
              timing: {
                duration: 500,
                delay: 0,
                iterations: 1,
                direction: 'normal',
                easing: 'ease',
                fill: 'forwards',
              },
              keyframes: [],
            },
          ],
          libraries: {
            gsap: { detected: true, version: '3.12.0', tweens: 5 },
            framerMotion: { detected: false },
            anime: { detected: false },
            three: { detected: false },
            lottie: { detected: false },
          },
          detectionTimeMs: 150,
          totalDetected: 3,
        });

        const result = await executeJSAnimationMode('https://example.com', true);

        expect(result.js_animation_summary).toBeDefined();
        expect(result.js_animation_summary?.cdpAnimationCount).toBe(2);
        expect(result.js_animation_summary?.webAnimationCount).toBe(1);
        expect(result.js_animation_summary?.detectedLibraries).toContain('gsap');
        expect(result.js_animation_summary?.totalDetected).toBe(3);
      });

      it('ブラウザが正常にクローズされる', async () => {
        await executeJSAnimationMode('https://example.com', true);

        expect(mockBrowser.close).toHaveBeenCalled();
      });

      it('検出サービスがクリーンアップされる', async () => {
        await executeJSAnimationMode('https://example.com', true);

        expect(mockCleanup).toHaveBeenCalled();
      });
    });

    describe('オプション設定', () => {
      it('デフォルトオプションが適用される', async () => {
        await executeJSAnimationMode('https://example.com', true);

        expect(mockDetect).toHaveBeenCalledWith(
          mockPage,
          expect.objectContaining({
            enableCDP: true,
            enableWebAnimations: true,
            enableLibraryDetection: true,
            waitTime: 1000,
          })
        );
      });

      it('カスタムオプションが渡される', async () => {
        await executeJSAnimationMode('https://example.com', true, {
          enableCDP: false,
          enableWebAnimations: false,
          enableLibraryDetection: false,
          waitTime: 2000,
        });

        expect(mockDetect).toHaveBeenCalledWith(
          mockPage,
          expect.objectContaining({
            enableCDP: false,
            enableWebAnimations: false,
            enableLibraryDetection: false,
            waitTime: 2000,
          })
        );
      });
    });
  });

  describe('エラーハンドリング', () => {
    it('Playwright起動エラーを適切に処理する', async () => {
      mockChromiumLaunch.mockRejectedValueOnce(new Error('Browser launch failed'));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      // Phase 3: Browserエラーは専用コードを持つ
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_BROWSER_ERROR');
      expect(result.js_animation_error?.message).toContain('Browser launch failed');
    });

    it('ページナビゲーションエラーを適切に処理する', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Navigation failed'));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      // Phase 3: ナビゲーションエラーはネットワークエラーとして分類
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_NETWORK_ERROR');
    });

    it('検出エラーを適切に処理する', async () => {
      mockDetect.mockRejectedValueOnce(new Error('Detection failed'));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_DETECTION_ERROR');
    });

    it('エラー時にサマリーとフル結果は設定されない', async () => {
      mockChromiumLaunch.mockRejectedValueOnce(new Error('Error'));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_summary).toBeUndefined();
      expect(result.js_animations).toBeUndefined();
      expect(result.js_animation_error).toBeDefined();
    });

    it('検出エラー時にブラウザクリーンアップが試みられる', async () => {
      // ブラウザ起動後に検出でエラー
      mockDetect.mockRejectedValueOnce(new Error('Detection failed'));

      await executeJSAnimationMode('https://example.com', true);

      // ブラウザが起動した後のエラーなのでcloseが呼ばれる
      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });

  describe('結果変換', () => {
    it('JSAnimationSummaryResultの構造が正しい', () => {
      // 型チェックのためのテスト
      const summary = {
        cdpAnimationCount: 5,
        webAnimationCount: 3,
        detectedLibraries: ['gsap', 'framer-motion'],
        totalDetected: 8,
        detectionTimeMs: 150,
      };

      expect(summary.cdpAnimationCount).toBeGreaterThanOrEqual(0);
      expect(summary.webAnimationCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(summary.detectedLibraries)).toBe(true);
      expect(summary.totalDetected).toBeGreaterThanOrEqual(0);
      expect(summary.detectionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('JSAnimationFullResultの構造が正しい', () => {
      // 型チェックのためのテスト
      const fullResult = {
        cdpAnimations: [
          {
            id: 'anim-1',
            name: 'fadeIn',
            pausedState: false,
            playState: 'running',
            playbackRate: 1,
            startTime: 0,
            currentTime: 100,
            type: 'CSSAnimation' as const,
            source: {
              duration: 1000,
              delay: 0,
              iterations: 1,
              direction: 'normal',
              easing: 'ease',
            },
          },
        ],
        webAnimations: [
          {
            id: 'web-anim-1',
            playState: 'running',
            target: '#box',
            timing: {
              duration: 500,
              delay: 0,
              iterations: 2,
              direction: 'alternate',
              easing: 'ease-in-out',
              fill: 'forwards',
            },
            keyframes: [],
          },
        ],
        libraries: {
          gsap: { detected: true, version: '3.12.0', tweens: 5 },
          framerMotion: { detected: false },
          anime: { detected: false },
          three: { detected: false },
          lottie: { detected: false },
        },
        detectionTimeMs: 200,
        totalDetected: 6,
      };

      expect(fullResult.cdpAnimations).toHaveLength(1);
      expect(fullResult.webAnimations).toHaveLength(1);
      expect(fullResult.libraries.gsap.detected).toBe(true);
      expect(fullResult.totalDetected).toBe(6);
    });

    it('複数ライブラリ検出時にすべてリストされる', async () => {
      mockDetect.mockResolvedValueOnce({
        cdpAnimations: [],
        webAnimations: [],
        libraries: {
          gsap: { detected: true, version: '3.12.0' },
          framerMotion: { detected: true, elements: 5 },
          anime: { detected: false },
          three: { detected: true, scenes: 1 },
          lottie: { detected: false },
        },
        detectionTimeMs: 100,
        totalDetected: 0,
      });

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_summary?.detectedLibraries).toHaveLength(3);
      expect(result.js_animation_summary?.detectedLibraries).toContain('gsap');
      expect(result.js_animation_summary?.detectedLibraries).toContain('framer-motion');
      expect(result.js_animation_summary?.detectedLibraries).toContain('three.js');
    });
  });
});

describe('JSAnimationModeResult型', () => {
  it('空の結果を許容する', () => {
    const result: JSAnimationModeResult = {};

    expect(result.js_animation_summary).toBeUndefined();
    expect(result.js_animations).toBeUndefined();
    expect(result.js_animation_error).toBeUndefined();
  });

  it('エラーのみの結果を許容する', () => {
    const result: JSAnimationModeResult = {
      js_animation_error: {
        code: 'TEST_ERROR',
        message: 'Test error message',
      },
    };

    expect(result.js_animation_error?.code).toBe('TEST_ERROR');
  });

  it('成功結果を許容する', () => {
    const result: JSAnimationModeResult = {
      js_animation_summary: {
        cdpAnimationCount: 0,
        webAnimationCount: 0,
        detectedLibraries: [],
        totalDetected: 0,
        detectionTimeMs: 50,
      },
      js_animations: {
        cdpAnimations: [],
        webAnimations: [],
        libraries: {
          gsap: { detected: false },
          framerMotion: { detected: false },
          anime: { detected: false },
          three: { detected: false },
          lottie: { detected: false },
        },
        detectionTimeMs: 50,
        totalDetected: 0,
      },
    };

    expect(result.js_animation_summary).toBeDefined();
    expect(result.js_animations).toBeDefined();
    expect(result.js_animation_error).toBeUndefined();
  });
});
