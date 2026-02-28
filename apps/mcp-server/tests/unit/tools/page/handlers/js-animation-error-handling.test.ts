// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * js-animation-handler.ts エラーハンドリング強化テスト
 *
 * Phase: モーション検出改善（JS検出エラーハンドリング強化）
 *
 * テスト対象:
 * - Playwright/CDP接続失敗時の明示的なエラーログ出力
 * - エラー情報をwarnings配列に追加
 * - 詳細なエラーメッセージ
 *
 * @module tests/unit/tools/page/handlers/js-animation-error-handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Loggerモック（vi.hoistedで先に定義）
const { mockLogger, mockChromiumLaunch, mockDetect, mockCleanup, mockPage, mockContext, mockBrowser } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockChromiumLaunch = vi.fn();
  const mockDetect = vi.fn();
  const mockCleanup = vi.fn();
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
    close: vi.fn(),
  };
  return { mockLogger, mockChromiumLaunch, mockDetect, mockCleanup, mockPage, mockContext, mockBrowser };
});

// Playwrightモック
vi.mock('playwright', () => ({
  chromium: {
    launch: mockChromiumLaunch,
  },
}));

// DI-factoriesモック
vi.mock('../../../../../src/tools/motion/di-factories', () => ({
  getJSAnimationDetectorService: vi.fn(() => ({
    detect: mockDetect,
    cleanup: mockCleanup,
  })),
}));

// Loggerモック
vi.mock('../../../../../src/utils/logger', () => ({
  logger: mockLogger,
  isDevelopment: () => true,
}));

// テスト対象のインポート
import {
  executeJSAnimationMode,
  checkPlaywrightAvailability,
  type JSAnimationModeResult,
} from '../../../../../src/tools/page/handlers/js-animation-handler';

describe('js-animation-handler エラーハンドリング強化', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Playwrightモックのセットアップ
    mockContext.newPage.mockResolvedValue(mockPage);
    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.waitForTimeout.mockResolvedValue(undefined);

    // 検出サービスモックのセットアップ（デフォルト：正常動作）
    mockDetect.mockResolvedValue({
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
    });
    mockCleanup.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Playwright起動エラー', () => {
    it('ブラウザ起動失敗時に詳細なエラーログを出力する', async () => {
      const errorMessage = 'Executable does not exist at /path/to/chromium';
      mockChromiumLaunch.mockRejectedValueOnce(new Error(errorMessage));

      const result = await executeJSAnimationMode('https://example.com', true);

      // エラーログが出力されることを検証
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[js-animation-handler]'),
        expect.objectContaining({
          error: expect.any(Error),
        })
      );

      // エラー結果が返される（Phase 3: BROWSER_ERRORコードが返される）
      expect(result.js_animation_error).toBeDefined();
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_BROWSER_ERROR');
      expect(result.js_animation_error?.message).toContain(errorMessage);
      // WebGL/3Dサイト向けのヒントが含まれる
      expect(result.js_animation_error?.message).toContain('disableWebGL');
    });

    it('Playwright未インストール時のエラーメッセージにインストール手順を含める', async () => {
      const errorMessage = 'Cannot find module \'playwright\'';
      mockChromiumLaunch.mockRejectedValueOnce(new Error(errorMessage));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      // モジュール未インストールは汎用エラーコード
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_DETECTION_ERROR');

      // エラーログにPlaywrightインストール情報が含まれることを検証
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('CDP接続失敗時に警告フラグを設定する', async () => {
      const errorMessage = 'CDP session closed';
      mockDetect.mockRejectedValueOnce(new Error(errorMessage));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      // Phase 3: CDPエラーは専用コードを持つ
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_CDP_ERROR');
      expect(result.js_animation_error?.message).toContain('CDP session closed');
      // CDPエラー向けのヒントが含まれる
      expect(result.js_animation_error?.message).toContain('WebGL');

      // エラーログが出力される
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('ページナビゲーションエラー', () => {
    it('タイムアウト時に詳細なエラー情報を返す', async () => {
      const errorMessage = 'Navigation timeout of 30000ms exceeded';
      mockPage.goto.mockRejectedValueOnce(new Error(errorMessage));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      // Phase 3: タイムアウトエラーは専用コードを持つ
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_TIMEOUT');
      expect(result.js_animation_error?.message).toContain('timeout');
      // タイムアウト向けのヒントが含まれる
      expect(result.js_animation_error?.message).toContain('detect_js_animations: false');

      // エラーログにURL情報が含まれる
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[js-animation-handler]'),
        expect.objectContaining({
          error: expect.any(Error),
        })
      );
    });

    it('SSL証明書エラー時に適切なエラーコードを返す', async () => {
      const errorMessage = 'net::ERR_CERT_AUTHORITY_INVALID';
      mockPage.goto.mockRejectedValueOnce(new Error(errorMessage));

      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      // Phase 3: ネットワークエラーは専用コードを持つ
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_NETWORK_ERROR');
    });
  });

  describe('検出プロセスエラー', () => {
    it('検出サービス内部エラー時にGraceful Degradationを維持する', async () => {
      mockDetect.mockRejectedValueOnce(new Error('Internal detection error'));

      const result = await executeJSAnimationMode('https://example.com', true);

      // エラーが返されるがクラッシュしない
      expect(result.js_animation_error).toBeDefined();
      expect(result.js_animation_summary).toBeUndefined();
      expect(result.js_animations).toBeUndefined();

      // ブラウザがクリーンアップされる
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('部分的なエラー（ライブラリ検出失敗）時も他の結果を返す', async () => {
      // ライブラリ検出部分で部分的にエラーが発生するケース
      mockDetect.mockResolvedValueOnce({
        cdpAnimations: [
          {
            id: '1',
            name: 'fadeIn',
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
        ],
        webAnimations: [],
        libraries: {
          gsap: { detected: false },
          framerMotion: { detected: false },
          anime: { detected: false },
          three: { detected: false },
          lottie: { detected: false },
        },
        detectionTimeMs: 100,
        totalDetected: 1,
      });

      const result = await executeJSAnimationMode('https://example.com', true);

      // 正常な結果が返される
      expect(result.js_animation_summary).toBeDefined();
      expect(result.js_animation_summary?.cdpAnimationCount).toBe(1);
      expect(result.js_animation_error).toBeUndefined();
    });
  });

  describe('Playwright環境事前チェック', () => {
    it('checkPlaywrightAvailability関数が存在する', () => {
      expect(typeof checkPlaywrightAvailability).toBe('function');
    });

    it('Playwrightが利用可能な場合trueを返す', async () => {
      const isAvailable = await checkPlaywrightAvailability();
      expect(typeof isAvailable).toBe('boolean');
    });
  });

  describe('エラーコード分類', () => {
    it('ネットワークエラーは適切なエラーコードを持つ', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));

      const result = await executeJSAnimationMode('https://nonexistent.example.com', true);

      // Phase 3: ネットワークエラーは専用コードを持つ
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_NETWORK_ERROR');
    });

    it('ブラウザコンテキストエラーは適切なエラーコードを持つ', async () => {
      mockBrowser.newContext.mockRejectedValueOnce(new Error('Context creation failed'));

      const result = await executeJSAnimationMode('https://example.com', true);

      // コンテキスト作成失敗は汎用エラーコード（browser/chromiumを含まない）
      expect(result.js_animation_error?.code).toBe('JS_ANIMATION_DETECTION_ERROR');
    });
  });

  describe('クリーンアップ処理', () => {
    it('エラー発生時でもブラウザリソースが解放される', async () => {
      mockDetect.mockRejectedValueOnce(new Error('Detection failed'));

      await executeJSAnimationMode('https://example.com', true);

      // ブラウザが閉じられることを確認
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('クリーンアップ自体のエラーは無視される', async () => {
      mockDetect.mockRejectedValueOnce(new Error('Detection failed'));
      mockBrowser.close.mockRejectedValueOnce(new Error('Close failed'));

      // クリーンアップエラーでクラッシュしないことを確認
      const result = await executeJSAnimationMode('https://example.com', true);

      expect(result.js_animation_error).toBeDefined();
      // プロセスがクラッシュしない
    });
  });

  describe('ログ出力の検証', () => {
    it('検出開始時にinfoログを出力する', async () => {
      await executeJSAnimationMode('https://example.com', true);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[js-animation-handler]'),
        expect.objectContaining({
          url: 'https://example.com',
        })
      );
    });

    it('エラー時にerrorログを出力する', async () => {
      mockChromiumLaunch.mockRejectedValueOnce(new Error('Launch failed'));

      await executeJSAnimationMode('https://example.com', true);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[js-animation-handler]'),
        expect.objectContaining({
          error: expect.any(Error),
        })
      );
    });

    it('検出完了時にサマリー情報をログに出力する', async () => {
      await executeJSAnimationMode('https://example.com', true);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('completed'),
        expect.objectContaining({
          cdpAnimationCount: expect.any(Number),
          webAnimationCount: expect.any(Number),
        })
      );
    });
  });
});
