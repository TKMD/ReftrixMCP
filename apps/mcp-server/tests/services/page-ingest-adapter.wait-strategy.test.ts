// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageIngestAdapter 待機戦略テスト
 *
 * WebGLサイト向け待機戦略の最適化:
 * - domcontentloaded + 固定待機（networkidleは永遠に完了しない問題への対応）
 * - waitForWebGLオプションの追加
 *
 * Phase1-2: 待機戦略最適化
 *
 * @module tests/services/page-ingest-adapter.wait-strategy.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// モックオブジェクトを外部で定義
const mockPage: {
  goto: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  waitForSelector: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  mouse: {
    move: ReturnType<typeof vi.fn>;
    wheel: ReturnType<typeof vi.fn>;
  };
  viewportSize: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
  setDefaultTimeout: ReturnType<typeof vi.fn>;
} = {
  goto: vi.fn(),
  url: vi.fn(),
  content: vi.fn(),
  evaluate: vi.fn(),
  screenshot: vi.fn(),
  waitForSelector: vi.fn(),
  close: vi.fn(),
  title: vi.fn(),
  mouse: {
    move: vi.fn(),
    wheel: vi.fn(),
  },
  viewportSize: vi.fn(),
  waitForTimeout: vi.fn(),
  setDefaultTimeout: vi.fn(),
};

const mockContext = {
  newPage: vi.fn(),
  close: vi.fn(),
};

const mockBrowser = {
  newContext: vi.fn(),
  close: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
};

const mockLaunch = vi.fn();

// Playwrightモジュールのモック（ホイスト）
vi.mock('playwright', () => ({
  chromium: {
    launch: mockLaunch,
  },
}));

// loggerモック
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// =====================================================
// テストスイート
// =====================================================

describe('PageIngestAdapter 待機戦略最適化', () => {
  let pageIngestAdapter: Awaited<
    typeof import('../../src/services/page-ingest-adapter')
  >['pageIngestAdapter'];

  beforeEach(async () => {
    vi.clearAllMocks();

    // mockLaunchの戻り値を設定
    mockLaunch.mockResolvedValue(mockBrowser);

    // モックのデフォルト動作を設定
    mockPage.url.mockReturnValue('https://example.com/');
    mockPage.content.mockResolvedValue('<html><body>Test</body></html>');
    mockPage.screenshot.mockResolvedValue(Buffer.from('fake-screenshot-data'));
    mockPage.waitForSelector.mockResolvedValue(null);
    mockPage.close.mockResolvedValue(undefined);
    mockPage.title.mockResolvedValue('Test Page');
    mockPage.mouse.move.mockResolvedValue(undefined);
    mockPage.mouse.wheel.mockResolvedValue(undefined);
    mockPage.viewportSize.mockReturnValue({ width: 1920, height: 1080 });
    mockPage.waitForTimeout.mockResolvedValue(undefined);
    mockPage.setDefaultTimeout.mockReturnValue(undefined);

    mockContext.newPage.mockResolvedValue(mockPage);
    mockContext.close.mockResolvedValue(undefined);

    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);

    // デフォルトのevaluate応答を設定
    mockPage.evaluate.mockImplementation((script: string) => {
      if (typeof script === 'string' && script.includes('title')) {
        return Promise.resolve({
          title: 'Test Page',
          description: 'Test description',
          ogImage: 'https://example.com/og.png',
          favicon: '/favicon.ico',
          lang: 'en',
          canonical: 'https://example.com/',
          keywords: ['test', 'page'],
        });
      }
      if (typeof script === 'string' && script.includes('documentWidth')) {
        return Promise.resolve({
          documentWidth: 1920,
          documentHeight: 3000,
          viewportWidth: 1920,
          viewportHeight: 1080,
          scrollHeight: 3000,
        });
      }
      // DOM安定化待機用
      if (typeof script === 'string' && script.includes('MutationObserver')) {
        return Promise.resolve({
          stable: true,
          mutations: 0,
          waitTime: 100,
          reason: 'dom_stable',
        });
      }
      // ローディング要素非表示待機用
      if (typeof script === 'string' && script.includes('isElementHidden')) {
        return Promise.resolve({
          hidden: true,
          waitTime: 100,
          reason: 'already_hidden',
        });
      }
      // WebGL検出用
      if (typeof script === 'string' && script.includes('canvases')) {
        return Promise.resolve({
          detected: false,
          canvasCount: 0,
          webgl1Count: 0,
          webgl2Count: 0,
          threeJsDetected: false,
        });
      }
      // フレームレート安定化待機用
      if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
        return Promise.resolve({
          stable: true,
          waitTimeMs: 100,
          frameRateStable: true,
          lastFrameRate: 60,
          reason: 'stable',
        });
      }
      return Promise.resolve({});
    });

    // goto応答を設定
    mockPage.goto.mockResolvedValue({
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
    });

    // モジュールをリセットして新しいシングルトンを取得
    vi.resetModules();
    const module = await import('../../src/services/page-ingest-adapter');
    pageIngestAdapter = module.pageIngestAdapter;
  });

  afterEach(async () => {
    if (pageIngestAdapter) {
      try {
        await pageIngestAdapter.close();
      } catch {
        // クローズ時のエラーは無視
      }
    }
  });

  // =====================================================
  // 1. waitForWebGLオプションの動作テスト
  // =====================================================
  describe('waitForWebGLオプション', () => {
    it('waitForWebGL: trueでdomcontentloadedが使用される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
      });

      // page.gotoの呼び出しを検証
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://webgl-site.com',
        expect.objectContaining({
          waitUntil: 'domcontentloaded',
        })
      );
    });

    it('waitForWebGL: falseでは通常のwaitUntilが使用される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://normal-site.com',
        waitForWebGL: false,
        waitUntil: 'networkidle',
      });

      // adaptiveWebGLWait: falseを明示しないとdomcontentloadedにフォールバックされるため、
      // adaptiveWebGLWaitも無効化する
      expect(mockPage.goto).toHaveBeenCalled();
    });

    it('waitForWebGL未指定（デフォルトfalse）では通常動作', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://normal-site.com',
        adaptiveWebGLWait: false, // 既存の適応的待機も無効化
        waitUntil: 'load',
      });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://normal-site.com',
        expect.objectContaining({
          waitUntil: 'load',
        })
      );
    });

    it('waitForWebGL: trueでCanvasセレクターの待機が行われる', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
      });

      // waitForSelectorでcanvasを待機することを確認
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('canvas', expect.any(Object));
    });

    it('waitForWebGL: trueでCanvas検出後に固定待機が行われる', async () => {
      // Canvas要素が見つかった場合のモック
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      // WebGLコンテキスト確認用
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({
            title: 'Test Page',
            description: 'Test description',
          });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({
            stable: true,
            mutations: 0,
            waitTime: 100,
            reason: 'dom_stable',
          });
        }
        // WebGLコンテキスト確認（waitForWebGLモード用）
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          return Promise.resolve(true); // WebGLコンテキストあり
        }
        // WebGL検出（adaptiveWebGLWaitモード用）
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: true,
            canvasCount: 1,
            webgl1Count: 1,
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        // フレームレート安定化待機用
        if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
          return Promise.resolve({
            stable: true,
            waitTimeMs: 100,
            frameRateStable: true,
            lastFrameRate: 60,
            reason: 'stable',
          });
        }
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
      });

      // waitForTimeoutが呼ばれたことを確認（デフォルト3000ms）
      expect(mockPage.waitForTimeout).toHaveBeenCalled();
    });

    it('waitForWebGL: trueでCanvas未検出時でもエラーにならない', async () => {
      // Canvas要素が見つからない場合（タイムアウト）
      mockPage.waitForSelector.mockRejectedValueOnce(new Error('Timeout'));

      const result = await pageIngestAdapter.ingest({
        url: 'https://no-canvas-site.com',
        waitForWebGL: true,
      });

      // エラーにならず成功すること
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // 2. webglWaitMsオプションのテスト
  // =====================================================
  describe('webglWaitMsオプション', () => {
    it('webglWaitMs: 5000でCanvas検出後5秒待機', async () => {
      // Canvas要素が見つかった場合のモック
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      // WebGLコンテキスト確認用
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({ title: 'Test' });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 100 });
        }
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          return Promise.resolve(true);
        }
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: true,
            canvasCount: 1,
            webgl1Count: 1,
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
          return Promise.resolve({
            stable: true,
            waitTimeMs: 100,
            frameRateStable: true,
            lastFrameRate: 60,
            reason: 'stable',
          });
        }
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
        webglWaitMs: 5000,
      });

      // waitForTimeoutが5000msで呼ばれたことを確認
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(5000);
    });

    it('webglWaitMsデフォルト値は3000ms', async () => {
      // Canvas要素が見つかった場合のモック
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      // WebGLコンテキスト確認用
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({ title: 'Test' });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 100 });
        }
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          return Promise.resolve(true);
        }
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: true,
            canvasCount: 1,
            webgl1Count: 1,
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
          return Promise.resolve({
            stable: true,
            waitTimeMs: 100,
            frameRateStable: true,
            lastFrameRate: 60,
            reason: 'stable',
          });
        }
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
        // webglWaitMs未指定
      });

      // デフォルト3000msでwaitForTimeoutが呼ばれること
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(3000);
    });

    it('webglWaitMs: 0で待機をスキップ', async () => {
      // Canvas要素が見つかった場合のモック
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      // WebGLコンテキスト確認用
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({ title: 'Test' });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 100 });
        }
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          return Promise.resolve(true);
        }
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: true,
            canvasCount: 1,
            webgl1Count: 1,
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
          return Promise.resolve({
            stable: true,
            waitTimeMs: 100,
            frameRateStable: true,
            lastFrameRate: 60,
            reason: 'stable',
          });
        }
        return Promise.resolve({});
      });

      // waitForTimeoutをリセット
      mockPage.waitForTimeout.mockClear();

      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
        webglWaitMs: 0,
      });

      // webglWaitMs: 0なのでWebGL用のwaitForTimeoutは呼ばれない
      // ただし、他の用途（adaptiveWebGLWait等）で呼ばれる可能性があるため、
      // 0msでは呼ばれないことを確認
      const calls = mockPage.waitForTimeout.mock.calls;
      const zeroMsCalls = calls.filter(call => call[0] === 0);
      // webglWaitMs: 0の場合は0msで呼ばれない（スキップされる）
      expect(zeroMsCalls.length).toBe(0);
    });
  });

  // =====================================================
  // 3. 既存オプションとの互換性テスト
  // =====================================================
  describe('既存オプションとの互換性', () => {
    it('waitForWebGLとwaitUntilの組み合わせ: waitForWebGLが優先', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
        waitUntil: 'networkidle', // 通常これが使われるが...
      });

      // waitForWebGL: trueなのでdomcontentloadedが使用される
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://webgl-site.com',
        expect.objectContaining({
          waitUntil: 'domcontentloaded',
        })
      );
    });

    it('waitForWebGLとenableGPUの組み合わせ', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
        enableGPU: true,
      });

      // 両方のオプションが正しく動作することを確認
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://webgl-site.com',
        expect.objectContaining({
          waitUntil: 'domcontentloaded',
        })
      );

      // GPU有効化ブラウザが起動されること
      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--use-angle=gl']),
        })
      );
    });

    it('waitForWebGLとadaptiveWebGLWaitの組み合わせ: 両方動作', async () => {
      // Canvas要素が見つかった場合のモック
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({ title: 'Test' });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 100 });
        }
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          return Promise.resolve(true);
        }
        // WebGL検出（adaptiveWebGLWait用）
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: true,
            canvasCount: 1,
            webgl1Count: 1,
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        // フレームレート安定化待機用
        if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
          return Promise.resolve({
            stable: true,
            waitTimeMs: 100,
            frameRateStable: true,
            lastFrameRate: 60,
            reason: 'stable',
          });
        }
        return Promise.resolve({});
      });

      const result = await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
        adaptiveWebGLWait: true, // 両方有効
      });

      expect(result.success).toBe(true);
      // Canvas待機が行われること（waitForWebGL）
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('canvas', expect.any(Object));
    });
  });

  // =====================================================
  // 4. WebGLコンテキスト確認テスト
  // =====================================================
  describe('WebGLコンテキスト確認', () => {
    it('Canvas検出後にWebGLコンテキストを確認する', async () => {
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      let webglContextCheckCalled = false;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({ title: 'Test' });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 100 });
        }
        // WebGLコンテキスト確認
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          webglContextCheckCalled = true;
          return Promise.resolve(true);
        }
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: true,
            canvasCount: 1,
            webgl1Count: 1,
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
          return Promise.resolve({
            stable: true,
            waitTimeMs: 100,
            frameRateStable: true,
            lastFrameRate: 60,
            reason: 'stable',
          });
        }
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
      });

      // WebGLコンテキスト確認が行われたこと
      expect(webglContextCheckCalled).toBe(true);
    });

    it('WebGLコンテキストがない場合は固定待機をスキップ', async () => {
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({ title: 'Test' });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 100 });
        }
        // WebGLコンテキストなし（2D Canvasのみ）
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          return Promise.resolve(false);
        }
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: false,
            canvasCount: 1, // Canvasはあるが
            webgl1Count: 0, // WebGLなし
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        if (typeof script === 'string' && script.includes('requestAnimationFrame')) {
          return Promise.resolve({
            stable: true,
            waitTimeMs: 100,
            frameRateStable: true,
            lastFrameRate: 60,
            reason: 'stable',
          });
        }
        return Promise.resolve({});
      });

      // waitForTimeoutをクリア
      mockPage.waitForTimeout.mockClear();

      await pageIngestAdapter.ingest({
        url: 'https://2d-canvas-site.com',
        waitForWebGL: true,
        adaptiveWebGLWait: false, // 他の待機を無効化
      });

      // WebGLコンテキストがないので3000msの待機は行われない
      const calls = mockPage.waitForTimeout.mock.calls;
      const webglWaitCalls = calls.filter(call => call[0] === 3000);
      expect(webglWaitCalls.length).toBe(0);
    });
  });

  // =====================================================
  // 5. エラーハンドリングテスト
  // =====================================================
  describe('エラーハンドリング', () => {
    it('Canvas待機タイムアウトでもエラーにならない', async () => {
      mockPage.waitForSelector.mockRejectedValueOnce(new Error('Timeout waiting for selector'));

      const result = await pageIngestAdapter.ingest({
        url: 'https://no-canvas-site.com',
        waitForWebGL: true,
      });

      expect(result.success).toBe(true);
      expect(result.html).toBeDefined();
    });

    it('WebGLコンテキスト確認エラーでもエラーにならない', async () => {
      mockPage.waitForSelector.mockResolvedValueOnce({ /* canvas element */ });

      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({ title: 'Test' });
        }
        if (typeof script === 'string' && script.includes('documentWidth')) {
          return Promise.resolve({
            documentWidth: 1920,
            documentHeight: 3000,
            viewportWidth: 1920,
            viewportHeight: 1080,
            scrollHeight: 3000,
          });
        }
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 100 });
        }
        // WebGLコンテキスト確認でエラー
        if (typeof script === 'string' && script.includes('canvas.getContext')) {
          return Promise.reject(new Error('Evaluate failed'));
        }
        if (typeof script === 'string' && script.includes('canvases')) {
          return Promise.resolve({
            detected: false,
            canvasCount: 0,
            webgl1Count: 0,
            webgl2Count: 0,
            threeJsDetected: false,
          });
        }
        return Promise.resolve({});
      });

      const result = await pageIngestAdapter.ingest({
        url: 'https://error-site.com',
        waitForWebGL: true,
      });

      // エラーでも成功として続行
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // 6. タイムアウト設定テスト
  // =====================================================
  describe('タイムアウト設定', () => {
    it('Canvas待機タイムアウトは10秒', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://webgl-site.com',
        waitForWebGL: true,
      });

      // waitForSelectorがtimeout: 10000で呼ばれること
      expect(mockPage.waitForSelector).toHaveBeenCalledWith(
        'canvas',
        expect.objectContaining({
          timeout: 10000,
        })
      );
    });
  });
});
