// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multi-Viewport Capture Service Tests
 *
 * MultiViewportCaptureService のユニットテスト
 * Playwright の Browser/BrowserContext/Page をモックし、
 * キャプチャフロー・エラーハンドリング・ブラウザ共有パターンを検証する
 *
 * @module tests/services/responsive/multi-viewport-capture.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import type {
  ResponsiveViewport,
  MultiViewportCaptureOptions,
  ViewportLayoutInfo,
  NavigationInfo,
} from '../../../src/services/responsive/types';

// ============================================================================
// playwright モック（chromium.launch を制御）
// vi.hoisted() で変数を先に宣言し、vi.mock ファクトリ内から安全に参照する
// ============================================================================

const { mockPage, mockContext, mockBrowser } = vi.hoisted(() => {
  const _mockPage = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html><body>test</body></html>'),
    evaluate: vi.fn().mockResolvedValue({}),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const _mockContext = {
    newPage: vi.fn().mockResolvedValue(_mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const _mockBrowser = {
    newContext: vi.fn().mockResolvedValue(_mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { mockPage: _mockPage, mockContext: _mockContext, mockBrowser: _mockBrowser };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

// logger モック（テスト出力を抑制）
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// external-css-fetcher モック（ネットワークリクエスト抑制）
vi.mock('../../../src/services/external-css-fetcher', () => ({
  extractCssUrls: vi.fn().mockReturnValue([]),
  fetchAllCss: vi.fn().mockResolvedValue([]),
}));

// ============================================================================
// テスト対象のインポート（モック適用後）
// ============================================================================

import {
  MultiViewportCaptureService,
  DEFAULT_VIEWPORTS,
} from '../../../src/services/responsive/multi-viewport-capture.service';

// ============================================================================
// テスト用サブクラス（private メソッドを公開）
// ============================================================================

class TestableMultiViewportCapture extends MultiViewportCaptureService {
  /**
   * createEmptyLayoutInfo をテスト用に公開
   */
  public testCreateEmptyLayoutInfo(viewport: ResponsiveViewport): ViewportLayoutInfo {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用に private メソッドにアクセス
    return (this as any).createEmptyLayoutInfo(viewport);
  }

  /**
   * createDefaultNavigationInfo をテスト用に公開
   */
  public testCreateDefaultNavigationInfo(): NavigationInfo {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用に private メソッドにアクセス
    return (this as any).createDefaultNavigationInfo();
  }

  /**
   * usingSharedBrowser フラグを取得
   */
  public getUsingSharedBrowser(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用に private フィールドにアクセス
    return (this as any).browserManager.isUsingSharedBrowser;
  }

  /**
   * browser フィールドを取得（browserManager 内部）
   */
  public getBrowserField(): Browser | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用に private フィールドにアクセス
    const manager = (this as any).browserManager;
    // SharedBrowserManager の private browser フィールドにアクセス
    return manager['browser'] as Browser | null;
  }
}

// ============================================================================
// ヘルパー関数
// ============================================================================

function createDefaultOptions(
  overrides: Partial<MultiViewportCaptureOptions> = {}
): MultiViewportCaptureOptions {
  return {
    viewports: DEFAULT_VIEWPORTS,
    includeScreenshots: false,
    timeout: 30000,
    ...overrides,
  };
}

/**
 * page.evaluate のモック戻り値をレイアウト情報用に設定
 */
function setupLayoutEvaluateMock(layoutInfo: Partial<ViewportLayoutInfo> = {}): void {
  const defaultLayout: ViewportLayoutInfo = {
    documentWidth: 1920,
    documentHeight: 3000,
    viewportWidth: 1920,
    viewportHeight: 1080,
    scrollHeight: 3000,
    breakpoints: ['768px', '1024px'],
    gridColumns: 3,
    flexDirection: 'row',
    typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.6 },
    spacing: {
      bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    },
  };

  const defaultNav: NavigationInfo = {
    type: 'horizontal-menu',
    hasHamburgerMenu: false,
    hasHorizontalMenu: true,
    hasBottomNav: false,
    selector: 'nav',
  };

  // page.evaluate は captureAtViewport 内で複数回呼ばれる:
  // 1. waitForDomStable (Promise<{ stable: boolean }>)
  // 2. extractLayoutInfo (ViewportLayoutInfo)
  // 3. detectNavigation (NavigationInfo)
  // 4. captureScreenshot 内 (scrollHeight) -- screenshot有効時のみ
  mockPage.evaluate
    .mockResolvedValueOnce({ stable: true })       // waitForDomStable
    .mockResolvedValueOnce({ ...defaultLayout, ...layoutInfo }) // extractLayoutInfo
    .mockResolvedValueOnce(defaultNav);             // detectNavigation
}

/**
 * 複数ビューポート分の evaluate モックを設定
 */
function setupMultiViewportEvaluateMock(count: number): void {
  for (let i = 0; i < count; i++) {
    setupLayoutEvaluateMock();
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('MultiViewportCaptureService', () => {
  let service: TestableMultiViewportCapture;

  beforeEach(() => {
    vi.clearAllMocks();

    // vi.clearAllMocks はモック実装もクリアするため、デフォルトの戻り値を再設定
    mockPage.setDefaultTimeout.mockReturnValue(undefined);
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.content.mockResolvedValue('<html><body>test</body></html>');
    mockPage.evaluate.mockResolvedValue({});
    mockPage.screenshot.mockResolvedValue(Buffer.from('fake-png'));
    mockPage.close.mockResolvedValue(undefined);
    mockContext.newPage.mockResolvedValue(mockPage);
    mockContext.close.mockResolvedValue(undefined);
    mockBrowser.newContext.mockResolvedValue(mockContext);
    mockBrowser.close.mockResolvedValue(undefined);

    service = new TestableMultiViewportCapture();
  });

  afterEach(async () => {
    await service.close();
  });

  // ==========================================================================
  // DEFAULT_VIEWPORTS 定数
  // ==========================================================================

  describe('DEFAULT_VIEWPORTS', () => {
    it('3つのビューポート（desktop, tablet, mobile）を定義している', () => {
      expect(DEFAULT_VIEWPORTS).toHaveLength(3);
      expect(DEFAULT_VIEWPORTS.map((v) => v.name)).toEqual(['desktop', 'tablet', 'mobile']);
    });

    it('desktop は 1920x1080', () => {
      const desktop = DEFAULT_VIEWPORTS.find((v) => v.name === 'desktop');
      expect(desktop).toBeDefined();
      expect(desktop!.width).toBe(1920);
      expect(desktop!.height).toBe(1080);
    });

    it('tablet は 768x1024', () => {
      const tablet = DEFAULT_VIEWPORTS.find((v) => v.name === 'tablet');
      expect(tablet).toBeDefined();
      expect(tablet!.width).toBe(768);
      expect(tablet!.height).toBe(1024);
    });

    it('mobile は 375x667', () => {
      const mobile = DEFAULT_VIEWPORTS.find((v) => v.name === 'mobile');
      expect(mobile).toBeDefined();
      expect(mobile!.width).toBe(375);
      expect(mobile!.height).toBe(667);
    });
  });

  // ==========================================================================
  // createEmptyLayoutInfo
  // ==========================================================================

  describe('createEmptyLayoutInfo', () => {
    it('ビューポートサイズを反映した空のレイアウト情報を返す', () => {
      const viewport: ResponsiveViewport = { name: 'mobile', width: 375, height: 667 };
      const info = service.testCreateEmptyLayoutInfo(viewport);

      expect(info.documentWidth).toBe(375);
      expect(info.documentHeight).toBe(667);
      expect(info.viewportWidth).toBe(375);
      expect(info.viewportHeight).toBe(667);
      expect(info.scrollHeight).toBe(667);
      expect(info.breakpoints).toEqual([]);
    });

    it('オプショナルフィールド（gridColumns, flexDirection, typography, spacing）が未定義', () => {
      const viewport: ResponsiveViewport = { name: 'desktop', width: 1920, height: 1080 };
      const info = service.testCreateEmptyLayoutInfo(viewport);

      expect(info.gridColumns).toBeUndefined();
      expect(info.flexDirection).toBeUndefined();
      expect(info.typography).toBeUndefined();
      expect(info.spacing).toBeUndefined();
    });
  });

  // ==========================================================================
  // createDefaultNavigationInfo
  // ==========================================================================

  describe('createDefaultNavigationInfo', () => {
    it('type が "other" のデフォルトナビゲーション情報を返す', () => {
      const info = service.testCreateDefaultNavigationInfo();

      expect(info.type).toBe('other');
      expect(info.hasHamburgerMenu).toBe(false);
      expect(info.hasHorizontalMenu).toBe(false);
      expect(info.hasBottomNav).toBe(false);
    });

    it('selector が未定義', () => {
      const info = service.testCreateDefaultNavigationInfo();
      expect(info.selector).toBeUndefined();
    });
  });

  // ==========================================================================
  // captureAllViewports
  // ==========================================================================

  describe('captureAllViewports', () => {
    it('デフォルトビューポート3つ分の結果を返す', async () => {
      setupMultiViewportEvaluateMock(3);
      const options = createDefaultOptions();

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results).toHaveLength(3);
      expect(results[0]!.viewport.name).toBe('desktop');
      expect(results[1]!.viewport.name).toBe('tablet');
      expect(results[2]!.viewport.name).toBe('mobile');
    });

    it('各結果に html と layoutInfo と navigationInfo が含まれる', async () => {
      setupMultiViewportEvaluateMock(3);
      const options = createDefaultOptions();

      const results = await service.captureAllViewports('https://example.com', options);

      for (const result of results) {
        expect(result.html).toBeTruthy();
        expect(result.layoutInfo).toBeDefined();
        expect(result.navigationInfo).toBeDefined();
        expect(result.error).toBeUndefined();
      }
    });

    it('カスタムビューポートを指定できる', async () => {
      const customViewports: ResponsiveViewport[] = [
        { name: 'wide', width: 2560, height: 1440 },
        { name: 'narrow', width: 320, height: 568 },
      ];
      setupMultiViewportEvaluateMock(2);

      const options = createDefaultOptions({ viewports: customViewports });
      const results = await service.captureAllViewports('https://example.com', options);

      expect(results).toHaveLength(2);
      expect(results[0]!.viewport.name).toBe('wide');
      expect(results[1]!.viewport.name).toBe('narrow');
    });

    it('page.goto に正しい URL とオプションが渡される', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        timeout: 15000,
        waitUntil: 'networkidle',
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        timeout: 15000,
        waitUntil: 'networkidle',
      });
    });

    it('waitUntil 未指定時はデフォルトで "load" が使用される', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        timeout: 30000,
        waitUntil: 'load',
      });
    });

    it('page.setDefaultTimeout に timeout が設定される', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        timeout: 45000,
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(45000);
    });

    it('mobile ビューポートにはモバイル UserAgent が設定される', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'mobile', width: 375, height: 667 }],
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: expect.stringContaining('iPhone'),
        })
      );
    });

    it('desktop ビューポートにはデスクトップ UserAgent が設定される', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: expect.stringContaining('Windows'),
        })
      );
    });

    it('ビューポートサイズが BrowserContext に正しく設定される', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'tablet', width: 768, height: 1024 }],
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 768, height: 1024 },
        })
      );
    });

    it('キャプチャ後に page と context が閉じられる', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockPage.close).toHaveBeenCalled();
      expect(mockContext.close).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DOM安定化待機
  // ==========================================================================

  describe('DOM安定化待機 (waitForDomStable)', () => {
    it('waitForDomStable が true（デフォルト）の場合、page.evaluate が呼ばれる', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports('https://example.com', options);

      // 最初の evaluate 呼び出しが waitForDomStable
      expect(mockPage.evaluate).toHaveBeenCalled();
      const firstCall = mockPage.evaluate.mock.calls[0]![0] as string;
      expect(firstCall).toContain('MutationObserver');
    });

    it('waitForDomStable: false で DOM安定待機をスキップする', async () => {
      // waitForDomStable=false の場合: evaluate は2回のみ（layout, nav）
      mockPage.evaluate
        .mockResolvedValueOnce({
          documentWidth: 1920, documentHeight: 1080, viewportWidth: 1920,
          viewportHeight: 1080, scrollHeight: 1080, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'other', hasHamburgerMenu: false,
          hasHorizontalMenu: false, hasBottomNav: false,
        });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        waitForDomStable: false,
      });

      await service.captureAllViewports('https://example.com', options);

      // MutationObserver を含む呼び出しがないことを確認
      const evaluateCalls = mockPage.evaluate.mock.calls;
      const hasMutationObserver = evaluateCalls.some((call) => {
        const arg = call[0];
        return typeof arg === 'string' && arg.includes('MutationObserver');
      });
      expect(hasMutationObserver).toBe(false);
    });

    it('domStableTimeout を指定できる', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        domStableTimeout: 1000,
      });

      await service.captureAllViewports('https://example.com', options);

      // waitForDomStable evaluate のスクリプトにタイムアウト値が含まれる
      const firstCall = mockPage.evaluate.mock.calls[0]![0] as string;
      expect(firstCall).toContain('1000');
    });
  });

  // ==========================================================================
  // スクリーンショット
  // ==========================================================================

  describe('スクリーンショット', () => {
    it('includeScreenshots: true で screenshot が結果に含まれる', async () => {
      // waitForDomStable + extractLayoutInfo + detectNavigation + captureScreenshot(scrollHeight)
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920, documentHeight: 3000, viewportWidth: 1920,
          viewportHeight: 1080, scrollHeight: 3000, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'horizontal-menu', hasHamburgerMenu: false,
          hasHorizontalMenu: true, hasBottomNav: false,
        })
        .mockResolvedValueOnce(3000); // captureScreenshot 内の scrollHeight evaluate

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        includeScreenshots: true,
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.screenshot).toBeDefined();
      expect(results[0]!.screenshot!.name).toBe('desktop');
      expect(results[0]!.screenshot!.width).toBe(1920);
      expect(results[0]!.screenshot!.height).toBe(1080);
      expect(results[0]!.screenshot!.screenshot).toBeDefined();
      expect(results[0]!.screenshot!.screenshot!.base64).toBeTruthy();
      expect(results[0]!.screenshot!.screenshot!.format).toBe('png');
    });

    it('includeScreenshots: false で screenshot が結果に含まれない', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        includeScreenshots: false,
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.screenshot).toBeUndefined();
    });

    it('fullPage: true でフルページスクリーンショットが撮影される', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920, documentHeight: 3000, viewportWidth: 1920,
          viewportHeight: 1080, scrollHeight: 3000, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'other', hasHamburgerMenu: false,
          hasHorizontalMenu: false, hasBottomNav: false,
        })
        .mockResolvedValueOnce(5000); // scrollHeight

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        includeScreenshots: true,
        fullPage: true,
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockPage.screenshot).toHaveBeenCalledWith({
        fullPage: true,
        type: 'png',
      });
    });

    it('fullPage 未指定時はデフォルトで true が使用される', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920, documentHeight: 3000, viewportWidth: 1920,
          viewportHeight: 1080, scrollHeight: 3000, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'other', hasHamburgerMenu: false,
          hasHorizontalMenu: false, hasBottomNav: false,
        })
        .mockResolvedValueOnce(3000);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
        includeScreenshots: true,
        // fullPage は未指定（デフォルト true）
      });

      await service.captureAllViewports('https://example.com', options);

      expect(mockPage.screenshot).toHaveBeenCalledWith({
        fullPage: true,
        type: 'png',
      });
    });
  });

  // ==========================================================================
  // エラーハンドリング
  // ==========================================================================

  describe('エラーハンドリング', () => {
    it('キャプチャ失敗時に空のレイアウト情報とデフォルトナビゲーション情報を返す', async () => {
      mockBrowser.newContext.mockRejectedValueOnce(new Error('Navigation failed'));
      // 2番目のビューポートは正常
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [
          { name: 'desktop', width: 1920, height: 1080 },
          { name: 'mobile', width: 375, height: 667 },
        ],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results).toHaveLength(2);

      // 失敗したビューポート
      const failedResult = results[0]!;
      expect(failedResult.error).toBe('Navigation failed');
      expect(failedResult.html).toBe('');
      expect(failedResult.layoutInfo.documentWidth).toBe(1920);
      expect(failedResult.layoutInfo.documentHeight).toBe(1080);
      expect(failedResult.layoutInfo.breakpoints).toEqual([]);
      expect(failedResult.navigationInfo.type).toBe('other');
      expect(failedResult.navigationInfo.hasHamburgerMenu).toBe(false);

      // 成功したビューポート
      const successResult = results[1]!;
      expect(successResult.error).toBeUndefined();
      expect(successResult.html).toBeTruthy();
    });

    it('page.goto のタイムアウトエラーがキャッチされる', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'));
      // 残り2ビューポートは正常動作するよう再設定
      mockPage.goto.mockResolvedValue(undefined);
      setupMultiViewportEvaluateMock(2);

      const options = createDefaultOptions();

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results).toHaveLength(3);
      expect(results[0]!.error).toContain('Timeout');
      expect(results[1]!.error).toBeUndefined();
      expect(results[2]!.error).toBeUndefined();
    });

    it('非Error型のエラーもString化される', async () => {
      mockBrowser.newContext.mockRejectedValueOnce('string error');
      setupMultiViewportEvaluateMock(2);

      const options = createDefaultOptions();

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.error).toBe('string error');
    });

    it('全ビューポートが失敗しても結果配列が返される', async () => {
      mockBrowser.newContext.mockRejectedValue(new Error('Browser crash'));

      const options = createDefaultOptions();

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.error).toBe('Browser crash');
        expect(result.html).toBe('');
      }
    });

    it('page.close がエラーでもキャプチャは完了する', async () => {
      setupMultiViewportEvaluateMock(1);
      mockPage.close.mockRejectedValueOnce(new Error('Already closed'));

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      // エラーがスローされないことを確認
      const results = await service.captureAllViewports('https://example.com', options);
      expect(results).toHaveLength(1);
      expect(results[0]!.error).toBeUndefined();
    });

    it('context.close がエラーでもキャプチャは完了する', async () => {
      setupMultiViewportEvaluateMock(1);
      mockContext.close.mockRejectedValueOnce(new Error('Context error'));

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);
      expect(results).toHaveLength(1);
      expect(results[0]!.error).toBeUndefined();
    });
  });

  // ==========================================================================
  // ブラウザ共有パターン
  // ==========================================================================

  describe('ブラウザ共有パターン', () => {
    it('sharedBrowser を渡すと chromium.launch がスキップされる', async () => {
      setupMultiViewportEvaluateMock(1);

      const { chromium } = await import('playwright');

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports(
        'https://example.com',
        options,
        mockBrowser as unknown as Browser
      );

      // chromium.launch が呼ばれていないこと（sharedBrowser を使用するため）
      expect(chromium.launch).not.toHaveBeenCalled();
    });

    it('sharedBrowser 使用時は usingSharedBrowser フラグが true になる', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports(
        'https://example.com',
        options,
        mockBrowser as unknown as Browser
      );

      expect(service.getUsingSharedBrowser()).toBe(true);
    });

    it('sharedBrowser 未指定時は usingSharedBrowser フラグが false', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports('https://example.com', options);

      expect(service.getUsingSharedBrowser()).toBe(false);
    });
  });

  // ==========================================================================
  // close()
  // ==========================================================================

  describe('close', () => {
    it('自前のブラウザ使用時に close() でブラウザが閉じられる', async () => {
      setupMultiViewportEvaluateMock(1);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      // sharedBrowser なしで captureAllViewports を呼んでブラウザを起動
      await service.captureAllViewports('https://example.com', options);

      // browser フィールドが設定されていることを確認
      expect(service.getBrowserField()).toBeTruthy();

      await service.close();

      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('sharedBrowser 使用時は close() でブラウザが閉じられない', async () => {
      setupMultiViewportEvaluateMock(1);

      const sharedBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Browser;

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      await service.captureAllViewports('https://example.com', options, sharedBrowser);

      const closeSpy = (sharedBrowser as unknown as { close: ReturnType<typeof vi.fn> }).close;

      await service.close();

      // sharedBrowser.close は呼ばれない（所有者が管理するため）
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('ブラウザ未起動時に close() を呼んでもエラーにならない', async () => {
      // captureAllViewports を一度も呼ばずに close
      await expect(service.close()).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // extractLayoutInfo (page.evaluate の戻り値構造)
  // ==========================================================================

  describe('extractLayoutInfo', () => {
    it('page.evaluate からブレークポイント情報が返される', async () => {
      setupLayoutEvaluateMock({
        breakpoints: ['768px', '1024px', '1440px'],
      });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.breakpoints).toEqual(['768px', '1024px', '1440px']);
    });

    it('page.evaluate からグリッドカラム数が返される', async () => {
      setupLayoutEvaluateMock({ gridColumns: 4 });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.gridColumns).toBe(4);
    });

    it('page.evaluate からフレックス方向が返される', async () => {
      setupLayoutEvaluateMock({ flexDirection: 'column' });

      const options = createDefaultOptions({
        viewports: [{ name: 'mobile', width: 375, height: 667 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.flexDirection).toBe('column');
    });

    it('page.evaluate からタイポグラフィ情報が返される', async () => {
      setupLayoutEvaluateMock({
        typography: { h1FontSize: 32, bodyFontSize: 14, bodyLineHeight: 1.5 },
      });

      const options = createDefaultOptions({
        viewports: [{ name: 'mobile', width: 375, height: 667 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.typography).toEqual({
        h1FontSize: 32,
        bodyFontSize: 14,
        bodyLineHeight: 1.5,
      });
    });

    it('page.evaluate からスペーシング情報が返される', async () => {
      setupLayoutEvaluateMock({
        spacing: {
          bodyPadding: { top: 10, right: 20, bottom: 10, left: 20 },
          mainContainerPadding: { top: 16, right: 24, bottom: 16, left: 24 },
        },
      });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.spacing).toBeDefined();
      expect(results[0]!.layoutInfo.spacing!.bodyPadding.top).toBe(10);
      expect(results[0]!.layoutInfo.spacing!.mainContainerPadding).toBeDefined();
    });

    it('ドキュメントサイズ情報が正しく返される', async () => {
      setupLayoutEvaluateMock({
        documentWidth: 375,
        documentHeight: 5000,
        viewportWidth: 375,
        viewportHeight: 667,
        scrollHeight: 5000,
      });

      const options = createDefaultOptions({
        viewports: [{ name: 'mobile', width: 375, height: 667 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.documentWidth).toBe(375);
      expect(results[0]!.layoutInfo.documentHeight).toBe(5000);
      expect(results[0]!.layoutInfo.scrollHeight).toBe(5000);
    });
  });

  // ==========================================================================
  // detectNavigation (page.evaluate の戻り値構造)
  // ==========================================================================

  describe('detectNavigation', () => {
    it('horizontal-menu タイプが検出される', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920, documentHeight: 1080, viewportWidth: 1920,
          viewportHeight: 1080, scrollHeight: 1080, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'horizontal-menu',
          hasHamburgerMenu: false,
          hasHorizontalMenu: true,
          hasBottomNav: false,
          selector: 'header nav',
        } satisfies NavigationInfo);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.navigationInfo.type).toBe('horizontal-menu');
      expect(results[0]!.navigationInfo.hasHorizontalMenu).toBe(true);
      expect(results[0]!.navigationInfo.hasHamburgerMenu).toBe(false);
      expect(results[0]!.navigationInfo.selector).toBe('header nav');
    });

    it('hamburger-menu タイプが検出される', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 375, documentHeight: 667, viewportWidth: 375,
          viewportHeight: 667, scrollHeight: 667, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'hamburger-menu',
          hasHamburgerMenu: true,
          hasHorizontalMenu: false,
          hasBottomNav: false,
          selector: 'nav',
        } satisfies NavigationInfo);

      const options = createDefaultOptions({
        viewports: [{ name: 'mobile', width: 375, height: 667 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.navigationInfo.type).toBe('hamburger-menu');
      expect(results[0]!.navigationInfo.hasHamburgerMenu).toBe(true);
    });

    it('bottom-nav タイプが検出される', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 375, documentHeight: 667, viewportWidth: 375,
          viewportHeight: 667, scrollHeight: 667, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'bottom-nav',
          hasHamburgerMenu: false,
          hasHorizontalMenu: false,
          hasBottomNav: true,
        } satisfies NavigationInfo);

      const options = createDefaultOptions({
        viewports: [{ name: 'mobile', width: 375, height: 667 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.navigationInfo.type).toBe('bottom-nav');
      expect(results[0]!.navigationInfo.hasBottomNav).toBe(true);
    });

    it('ナビゲーション要素が見つからない場合は other タイプ', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920, documentHeight: 1080, viewportWidth: 1920,
          viewportHeight: 1080, scrollHeight: 1080, breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'other',
          hasHamburgerMenu: false,
          hasHorizontalMenu: false,
          hasBottomNav: false,
        } satisfies NavigationInfo);

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.navigationInfo.type).toBe('other');
      expect(results[0]!.navigationInfo.selector).toBeUndefined();
    });
  });

  // ==========================================================================
  // 順次処理の検証
  // ==========================================================================

  describe('順次処理', () => {
    it('ビューポートは順次（直列）でキャプチャされる', async () => {
      const callOrder: string[] = [];

      mockBrowser.newContext.mockImplementation(async (opts: Record<string, unknown>) => {
        const viewport = opts['viewport'] as { width: number } | undefined;
        callOrder.push(`context-${viewport?.width ?? 'unknown'}`);
        return mockContext;
      });

      setupMultiViewportEvaluateMock(3);

      const options = createDefaultOptions();
      await service.captureAllViewports('https://example.com', options);

      // desktop(1920) → tablet(768) → mobile(375) の順序
      expect(callOrder).toEqual(['context-1920', 'context-768', 'context-375']);
    });
  });

  // ==========================================================================
  // Phase 2: computedStyleベースのセマンティック要素走査
  // ==========================================================================

  describe('Phase 2: semanticElements in extractLayoutInfo', () => {
    it('page.evaluate からセマンティック要素のcomputedStyle情報が返される', async () => {
      const semanticElements = [
        {
          selector: 'header',
          tagName: 'header',
          display: 'flex',
          visibility: 'visible',
          opacity: 1,
          flexDirection: 'row',
          boundingRect: { x: 0, y: 0, width: 1920, height: 80 },
        },
        {
          selector: 'aside.sidebar',
          tagName: 'aside',
          display: 'block',
          visibility: 'visible',
          opacity: 1,
          gridColumns: 1,
          boundingRect: { x: 0, y: 80, width: 300, height: 800 },
        },
      ];

      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })       // waitForDomStable
        .mockResolvedValueOnce({                        // extractLayoutInfo
          documentWidth: 1920,
          documentHeight: 3000,
          viewportWidth: 1920,
          viewportHeight: 1080,
          scrollHeight: 3000,
          breakpoints: ['768px'],
          gridColumns: 3,
          flexDirection: 'row',
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.6 },
          spacing: { bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 } },
          semanticElements,
        })
        .mockResolvedValueOnce({                        // detectNavigation
          type: 'horizontal-menu',
          hasHamburgerMenu: false,
          hasHorizontalMenu: true,
          hasBottomNav: false,
        });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.semanticElements).toBeDefined();
      expect(results[0]!.layoutInfo.semanticElements).toHaveLength(2);
      expect(results[0]!.layoutInfo.semanticElements![0]!.selector).toBe('header');
      expect(results[0]!.layoutInfo.semanticElements![0]!.display).toBe('flex');
      expect(results[0]!.layoutInfo.semanticElements![0]!.flexDirection).toBe('row');
      expect(results[0]!.layoutInfo.semanticElements![1]!.selector).toBe('aside.sidebar');
      expect(results[0]!.layoutInfo.semanticElements![1]!.boundingRect).toBeDefined();
    });

    it('semanticElements が未指定の場合は undefined', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920,
          documentHeight: 3000,
          viewportWidth: 1920,
          viewportHeight: 1080,
          scrollHeight: 3000,
          breakpoints: [],
          // semanticElements 未指定
        })
        .mockResolvedValueOnce({
          type: 'other',
          hasHamburgerMenu: false,
          hasHorizontalMenu: false,
          hasBottomNav: false,
        });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.semanticElements).toBeUndefined();
    });
  });

  // ==========================================================================
  // Phase 4: 拡張タイポグラフィ・セクション間スペーシング
  // ==========================================================================

  describe('Phase 4: extendedTypography in extractLayoutInfo', () => {
    it('page.evaluate から拡張タイポグラフィ情報が返される（h1-h6）', async () => {
      const extendedTypography = {
        headings: [
          { tag: 'h1', fontSize: 48 },
          { tag: 'h2', fontSize: 36 },
          { tag: 'h3', fontSize: 28 },
          { tag: 'h4', fontSize: 22 },
          { tag: 'h5', fontSize: 18 },
          { tag: 'h6', fontSize: 16 },
        ],
        pFirstOfType: 16,
      };

      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920,
          documentHeight: 3000,
          viewportWidth: 1920,
          viewportHeight: 1080,
          scrollHeight: 3000,
          breakpoints: [],
          extendedTypography,
        })
        .mockResolvedValueOnce({
          type: 'other',
          hasHamburgerMenu: false,
          hasHorizontalMenu: false,
          hasBottomNav: false,
        });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.extendedTypography).toBeDefined();
      expect(results[0]!.layoutInfo.extendedTypography!.headings).toHaveLength(6);
      expect(results[0]!.layoutInfo.extendedTypography!.headings[0]!.tag).toBe('h1');
      expect(results[0]!.layoutInfo.extendedTypography!.headings[0]!.fontSize).toBe(48);
      expect(results[0]!.layoutInfo.extendedTypography!.pFirstOfType).toBe(16);
    });
  });

  describe('Phase 4: sectionSpacing in extractLayoutInfo', () => {
    it('page.evaluate からセクション間スペーシング情報が返される', async () => {
      const sectionSpacing = [
        { selector: 'section:nth-of-type(1)', marginTop: 0, marginBottom: 80 },
        { selector: 'section:nth-of-type(2)', marginTop: 80, marginBottom: 60 },
        { selector: 'section:nth-of-type(3)', marginTop: 60, marginBottom: 40 },
      ];

      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920,
          documentHeight: 3000,
          viewportWidth: 1920,
          viewportHeight: 1080,
          scrollHeight: 3000,
          breakpoints: [],
          sectionSpacing,
        })
        .mockResolvedValueOnce({
          type: 'other',
          hasHamburgerMenu: false,
          hasHorizontalMenu: false,
          hasBottomNav: false,
        });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.layoutInfo.sectionSpacing).toBeDefined();
      expect(results[0]!.layoutInfo.sectionSpacing).toHaveLength(3);
      expect(results[0]!.layoutInfo.sectionSpacing![0]!.marginTop).toBe(0);
      expect(results[0]!.layoutInfo.sectionSpacing![0]!.marginBottom).toBe(80);
    });
  });

  // ==========================================================================
  // Phase 3: BoundingRectベースのナビゲーション検出
  // ==========================================================================

  describe('Phase 3: BoundingRectベースのナビゲーション検出', () => {
    it('horizontal-menu はヘッダー領域（上部200px）内の水平リンクで判定される', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 1920,
          documentHeight: 3000,
          viewportWidth: 1920,
          viewportHeight: 1080,
          scrollHeight: 3000,
          breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'horizontal-menu',
          hasHamburgerMenu: false,
          hasHorizontalMenu: true,
          hasBottomNav: false,
          selector: 'header > nav',
        });

      const options = createDefaultOptions({
        viewports: [{ name: 'desktop', width: 1920, height: 1080 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.navigationInfo.type).toBe('horizontal-menu');
      expect(results[0]!.navigationInfo.hasHorizontalMenu).toBe(true);
      expect(results[0]!.navigationInfo.selector).toBe('header > nav');
    });

    it('hamburger-menu はハンバーガーアイコン要素で判定される', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce({ stable: true })
        .mockResolvedValueOnce({
          documentWidth: 375,
          documentHeight: 2000,
          viewportWidth: 375,
          viewportHeight: 667,
          scrollHeight: 2000,
          breakpoints: [],
        })
        .mockResolvedValueOnce({
          type: 'hamburger-menu',
          hasHamburgerMenu: true,
          hasHorizontalMenu: false,
          hasBottomNav: false,
          selector: 'button.menu-toggle',
        });

      const options = createDefaultOptions({
        viewports: [{ name: 'mobile', width: 375, height: 667 }],
      });

      const results = await service.captureAllViewports('https://example.com', options);

      expect(results[0]!.navigationInfo.type).toBe('hamburger-menu');
      expect(results[0]!.navigationInfo.hasHamburgerMenu).toBe(true);
      expect(results[0]!.navigationInfo.selector).toBe('button.menu-toggle');
    });
  });

  // ==========================================================================
  // 外部CSSブレークポイント抽出
  // ==========================================================================

  describe('extractBreakpointsFromExternalCss', () => {
    it('外部CSSからメディアクエリのブレークポイントを抽出する', async () => {
      const { extractCssUrls, fetchAllCss } = await import(
        '../../../src/services/external-css-fetcher'
      );

      // CSSのURLを返す
      (extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        'https://example.com/style.css',
      ]);

      // CSS内容にメディアクエリを含める
      (fetchAllCss as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          content: `
            @media (max-width: 768px) { .container { padding: 16px; } }
            @media (max-width: 480px) { .container { padding: 8px; } }
            @media (min-width: 1200px) { .container { max-width: 1140px; } }
          `,
        },
      ]);

      const breakpoints = await service.extractBreakpointsFromExternalCss(
        '<html><link rel="stylesheet" href="/style.css"></html>',
        'https://example.com'
      );

      expect(breakpoints).toContain('768px');
      expect(breakpoints).toContain('480px');
      expect(breakpoints).toContain('1200px');
    });

    it('外部CSSがない場合は空配列を返す', async () => {
      const { extractCssUrls } = await import(
        '../../../src/services/external-css-fetcher'
      );

      (extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const breakpoints = await service.extractBreakpointsFromExternalCss(
        '<html><body>No CSS</body></html>',
        'https://example.com'
      );

      expect(breakpoints).toEqual([]);
    });
  });
});
