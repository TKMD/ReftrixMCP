// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageIngestAdapter GPU有効化テスト
 *
 * WebGL重サイト（Linear、Vercel、Notion等）のパフォーマンス改善のため、
 * GPU有効化オプション（--use-angle=gl）を追加する
 *
 * Phase1-1: GPU有効化テスト
 *
 * @module tests/services/page-ingest-adapter.gpu.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// モックオブジェクトを外部で定義してテストからアクセス可能にする
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

describe('PageIngestAdapter GPU有効化', () => {
  // アダプターインスタンスをキャッシュ
  let pageIngestAdapter: Awaited<typeof import('../../src/services/page-ingest-adapter')>['pageIngestAdapter'];

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
    // ブラウザを閉じてシングルトン状態をリセット
    if (pageIngestAdapter) {
      try {
        await pageIngestAdapter.close();
      } catch {
        // クローズ時のエラーは無視
      }
    }
  });

  // =====================================================
  // 1. 通常ブラウザ（非WebGLサイト）の起動オプションテスト
  // =====================================================
  describe('通常ブラウザ起動オプション', () => {
    it('通常サイトでは--disable-gpuが設定される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-gpu']),
        })
      );
    });

    it('セキュリティ: 通常サイトでは--no-sandboxが削除されている', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      const launchCall = mockLaunch.mock.calls[0][0];
      expect(launchCall.args).not.toContain('--no-sandbox');
    });

    it('通常サイトでは--gpu-sandbox-start-earlyが設定される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--gpu-sandbox-start-early']),
        })
      );
    });

    it('通常サイトでは--disable-dev-shm-usageが設定される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-dev-shm-usage']),
        })
      );
    });

    it('通常サイトでは--disable-setuid-sandboxが設定される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-setuid-sandbox']),
        })
      );
    });
  });

  // =====================================================
  // 2. GPU有効化オプション（enableGPU: true）テスト
  // =====================================================
  describe('GPU有効化オプション（enableGPU: true）', () => {
    it('enableGPU: trueで--use-angle=glが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--use-angle=gl']),
        })
      );
    });

    it('enableGPU: trueで--disable-gpuが設定されない', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      const launchCall = mockLaunch.mock.calls[0][0];
      expect(launchCall.args).not.toContain('--disable-gpu');
    });

    it('enableGPU: trueで--enable-gpu-rasterizationが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--enable-gpu-rasterization']),
        })
      );
    });

    it('enableGPU: trueで--ignore-gpu-blocklistが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--ignore-gpu-blocklist']),
        })
      );
    });

    it('enableGPU: trueで--gpu-sandbox-start-earlyが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--gpu-sandbox-start-early']),
        })
      );
    });

    it('セキュリティ: enableGPU: trueでも--no-sandboxが設定されない', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      const launchCall = mockLaunch.mock.calls[0][0];
      expect(launchCall.args).not.toContain('--no-sandbox');
    });

    it('enableGPU: trueで--disable-dev-shm-usageが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-dev-shm-usage']),
        })
      );
    });

    it('enableGPU: trueで--disable-setuid-sandboxが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-setuid-sandbox']),
        })
      );
    });
  });

  // =====================================================
  // 3. デフォルト値テスト
  // =====================================================
  describe('デフォルト値', () => {
    it('enableGPUが未指定の場合はfalse扱い（GPU無効）', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-gpu']),
        })
      );
    });

    it('enableGPU: falseで--disable-gpuが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        enableGPU: false,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-gpu']),
        })
      );
    });
  });

  // =====================================================
  // 4. WebGL無効化ブラウザ（disableWebGL: true）テスト
  // =====================================================
  describe('WebGL無効化ブラウザ（disableWebGL: true）', () => {
    it('disableWebGL: trueでenableGPU: trueを指定しても--disable-gpuが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        disableWebGL: true,
        enableGPU: true, // disableWebGLが優先される
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-gpu']),
        })
      );
    });

    it('disableWebGL: trueで--disable-webglが設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        disableWebGL: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-webgl']),
        })
      );
    });

    it('disableWebGL: trueで--disable-webgl2が設定される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        disableWebGL: true,
      });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--disable-webgl2']),
        })
      );
    });

    it('disableWebGL: trueで--use-angle=glが設定されない', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        disableWebGL: true,
      });

      const launchCall = mockLaunch.mock.calls[0][0];
      expect(launchCall.args).not.toContain('--use-angle=gl');
    });
  });

  // =====================================================
  // 5. オプション競合テスト
  // =====================================================
  describe('オプション競合', () => {
    it('enableGPU: trueとdisableWebGL: trueが同時指定された場合、disableWebGLが優先', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        enableGPU: true,
        disableWebGL: true,
      });

      const launchCall = mockLaunch.mock.calls[0][0];
      // disableWebGLが優先されるため--disable-gpuが設定される
      expect(launchCall.args).toContain('--disable-gpu');
      // --use-angle=glは設定されない
      expect(launchCall.args).not.toContain('--use-angle=gl');
    });
  });

  // =====================================================
  // 6. 結果検証テスト
  // =====================================================
  describe('ingest結果', () => {
    it('enableGPU: trueでもingestが成功する', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://linear.app');
    });

    it('enableGPU: trueでHTMLが取得される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://linear.app',
        enableGPU: true,
      });

      expect(result.success).toBe(true);
      expect(result.html).toBeDefined();
      expect(result.htmlSize).toBeGreaterThan(0);
    });
  });

  // =====================================================
  // 7. セキュリティ強化テスト
  // =====================================================
  describe('セキュリティ強化', () => {
    it('全ての設定で--no-sandboxが含まれないこと', async () => {
      // 通常
      await pageIngestAdapter.ingest({ url: 'https://example.com' });
      let launchCall = mockLaunch.mock.calls[0][0];
      expect(launchCall.args).not.toContain('--no-sandbox');

      // モジュールリセット
      vi.clearAllMocks();
      vi.resetModules();
      const module = await import('../../src/services/page-ingest-adapter');
      pageIngestAdapter = module.pageIngestAdapter;

      // GPU有効化
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        enableGPU: true,
      });
      launchCall = mockLaunch.mock.calls[0][0];
      expect(launchCall.args).not.toContain('--no-sandbox');
    });

    it('全ての設定で--gpu-sandbox-start-earlyが含まれること', async () => {
      // 通常
      await pageIngestAdapter.ingest({ url: 'https://example.com' });
      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--gpu-sandbox-start-early']),
        })
      );

      // モジュールリセット
      vi.clearAllMocks();
      vi.resetModules();
      const module = await import('../../src/services/page-ingest-adapter');
      pageIngestAdapter = module.pageIngestAdapter;

      // GPU有効化
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        enableGPU: true,
      });
      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(['--gpu-sandbox-start-early']),
        })
      );
    });
  });
});
