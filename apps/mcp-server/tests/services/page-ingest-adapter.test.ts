// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageIngestAdapter サービス テスト
 *
 * Playwrightを使用したWebページインジェストサービスのユニットテスト
 * Playwrightはモックして依存を分離
 *
 * 目的:
 * - ブラウザの起動とコンテキスト管理
 * - ページのナビゲーションとHTML取得
 * - メタデータ抽出
 * - スクリーンショット取得
 * - エラーハンドリング
 * - リソースクリーンアップ
 *
 * @module tests/services/page-ingest-adapter.test
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

describe('PageIngestAdapter', () => {
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
    // Note: モジュールリセットにより毎回新しいインスタンスが作成されるため
    // イベントリスナーの蓄積を防ぐためクローズを確実に行う
    if (pageIngestAdapter) {
      try {
        await pageIngestAdapter.close();
      } catch {
        // クローズ時のエラーは無視（モックが既にリセットされている場合）
      }
    }
  });

  // =====================================================
  // 1. 基本機能テスト
  // =====================================================
  describe('基本機能', () => {
    it('pageIngestAdapterが正しくエクスポートされている', () => {
      expect(pageIngestAdapter).toBeDefined();
      expect(typeof pageIngestAdapter.ingest).toBe('function');
      expect(typeof pageIngestAdapter.close).toBe('function');
    });

    it('ingest()でURLからページデータを取得できる', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://example.com');
      expect(result.html).toBeDefined();
    });

    it('ingest()でHTMLコンテンツが取得される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.html).toBe('<html><body>Test</body></html>');
      expect(result.htmlSize).toBeGreaterThan(0);
    });

    it('ingest()でfinalUrlが正しく設定される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://example.com/');
    });
  });

  // =====================================================
  // 2. ブラウザ管理テスト
  // =====================================================
  describe('ブラウザ管理', () => {
    it('ブラウザがヘッドレスモードで起動される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          headless: true,
        })
      );
    });

    it('ブラウザが遅延初期化される（シングルトン）', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });
      await pageIngestAdapter.ingest({ url: 'https://example.com/page2' });

      // 2回のingestでも1回のlaunchのみ
      expect(mockLaunch).toHaveBeenCalledTimes(1);
    });

    it('close()でブラウザが終了される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });
      await pageIngestAdapter.close();

      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('各ingestでコンテキストとページがクリーンアップされる', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockPage.close).toHaveBeenCalled();
      expect(mockContext.close).toHaveBeenCalled();
    });
  });

  // =====================================================
  // 3. ビューポートとオプションテスト
  // =====================================================
  describe('ビューポートとオプション', () => {
    it('デフォルトビューポートが1920x1080', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1920, height: 1080 },
        })
      );
    });

    it('カスタムビューポートが適用される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        viewport: { width: 1440, height: 900 },
      });

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1440, height: 900 },
        })
      );
    });

    it('タイムアウトオプションがgoto()に渡される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        timeout: 60000,
      });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          timeout: 60000,
        })
      );
    });

    it('デフォルトタイムアウトは30秒', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          timeout: 30000,
        })
      );
    });

    it('waitUntilオプションが適用される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitUntil: 'networkidle',
      });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          waitUntil: 'networkidle',
        })
      );
    });

    it('デフォルトwaitUntilはdomcontentloaded（adaptiveWebGLWait有効時）', async () => {
      // adaptiveWebGLWaitがデフォルトで有効なため、'load'は'domcontentloaded'に変換される
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          waitUntil: 'domcontentloaded',
        })
      );
    });

    it('adaptiveWebGLWait無効時はwaitUntilがloadのまま', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        adaptiveWebGLWait: false,
      });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          waitUntil: 'load',
        })
      );
    });

    it('disableJavaScriptオプションが適用される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        disableJavaScript: true,
      });

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          javaScriptEnabled: false,
        })
      );
    });
  });

  // =====================================================
  // 4. waitForSelectorテスト
  // =====================================================
  describe('waitForSelector', () => {
    it('waitForSelectorが指定された場合にセレクターを待機する', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForSelector: '.main-content',
      });

      expect(mockPage.waitForSelector).toHaveBeenCalledWith(
        '.main-content',
        expect.objectContaining({
          timeout: expect.any(Number),
        })
      );
    });

    it('waitForSelectorが未指定の場合は待機しない', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(mockPage.waitForSelector).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 5. メタデータ抽出テスト
  // =====================================================
  describe('メタデータ抽出', () => {
    it('ページタイトルが抽出される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.metadata.title).toBe('Test Page');
    });

    it('descriptionが抽出される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.metadata.description).toBe('Test description');
    });

    it('ogImageが抽出される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.metadata.ogImage).toBe('https://example.com/og.png');
    });

    it('faviconが抽出される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.metadata.favicon).toBe('/favicon.ico');
    });

    it('langが抽出される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.metadata.lang).toBe('en');
    });
  });

  // =====================================================
  // 6. ビューポート情報テスト
  // =====================================================
  describe('ビューポート情報', () => {
    it('viewportInfoが正しく取得される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.viewportInfo).toBeDefined();
      expect(result.viewportInfo.documentWidth).toBe(1920);
      expect(result.viewportInfo.documentHeight).toBe(3000);
      expect(result.viewportInfo.scrollHeight).toBe(3000);
    });
  });

  // =====================================================
  // 7. スクリーンショットテスト
  // =====================================================
  describe('スクリーンショット', () => {
    it('スクリーンショットが取得される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.screenshots).toBeDefined();
      expect(result.screenshots).toHaveLength(1);
    });

    it('スクリーンショットのbase64データが含まれる', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.screenshots?.[0]?.data).toBeDefined();
      expect(typeof result.screenshots?.[0]?.data).toBe('string');
    });

    it('fullPage: trueでフルページスクリーンショットが取得される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        fullPage: true,
      });

      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({
          fullPage: true,
        })
      );
    });

    it('fullPage: falseでビューポートのみのスクリーンショットが取得される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        fullPage: false,
      });

      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({
          fullPage: false,
        })
      );
    });

    it('skipScreenshot: trueでスクリーンショットをスキップ', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        skipScreenshot: true,
      });

      expect(result.success).toBe(true);
      expect(result.screenshots).toBeUndefined();
      expect(mockPage.screenshot).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 8. ソース情報テスト
  // =====================================================
  describe('ソース情報', () => {
    it('デフォルトのsourceTypeがuser_provided', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.source.type).toBe('user_provided');
    });

    it('sourceType: award_galleryが設定される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        sourceType: 'award_gallery',
      });

      expect(result.success).toBe(true);
      expect(result.source.type).toBe('award_gallery');
    });

    it('デフォルトのusageScopeがinspiration_only', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.source.usageScope).toBe('inspiration_only');
    });

    it('usageScope: owned_assetが設定される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        usageScope: 'owned_asset',
      });

      expect(result.success).toBe(true);
      expect(result.source.usageScope).toBe('owned_asset');
    });
  });

  // =====================================================
  // 9. エラーハンドリングテスト
  // =====================================================
  describe('エラーハンドリング', () => {
    it('ページ応答がない場合にエラーを返す', async () => {
      mockPage.goto.mockResolvedValueOnce(null);

      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('No response');
    });

    it('タイムアウトエラーが正しく処理される', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Navigation timeout'));

      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('ネットワークエラーが正しく処理される', async () => {
      // ERR_NAME_NOT_RESOLVEDはDNSリトライ対象のため、非DNS系エラーを使用
      // ERR_CONNECTION_REFUSEDはDNSリトライ対象外で即座にthrowされる
      mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));

      const result = await pageIngestAdapter.ingest({
        url: 'https://nonexistent.invalid',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('エラー時にページとコンテキストがクリーンアップされる', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Test error'));

      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockPage.close).toHaveBeenCalled();
      expect(mockContext.close).toHaveBeenCalled();
    });

    it('エラー結果に必要なフィールドが含まれる', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Test error'));

      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(false);
      expect(result.url).toBe('https://example.com');
      expect(result.finalUrl).toBe('https://example.com');
      expect(result.html).toBe('');
      expect(result.htmlSize).toBe(0);
      expect(result.viewportInfo).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.ingestedAt).toBeInstanceOf(Date);
      expect(result.source).toBeDefined();
    });
  });

  // =====================================================
  // 10. ingestedAtタイムスタンプテスト
  // =====================================================
  describe('タイムスタンプ', () => {
    it('ingestedAtがDate型で返される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.ingestedAt).toBeInstanceOf(Date);
    });

    it('ingestedAtが現在時刻に近い', async () => {
      const before = new Date();
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });
      const after = new Date();

      expect(result.success).toBe(true);
      expect(result.ingestedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.ingestedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  // =====================================================
  // 11. ユーザーエージェントテスト
  // =====================================================
  describe('ユーザーエージェント', () => {
    it('カスタムユーザーエージェントが設定される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: expect.stringContaining('Mozilla/5.0'),
        })
      );
    });
  });

  // =====================================================
  // 12. 型定義テスト
  // =====================================================
  describe('型定義', () => {
    it('IngestResultの型が正しい', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      // 型チェック（コンパイル時に検証される）
      const url: string = result.url;
      const finalUrl: string = result.finalUrl;
      const html: string = result.html;
      const htmlSize: number = result.htmlSize;
      const success: boolean = result.success;
      const metadata: { title: string } = result.metadata;
      const source: { type: string; usageScope: string } = result.source;

      expect(url).toBeDefined();
      expect(finalUrl).toBeDefined();
      expect(html).toBeDefined();
      expect(htmlSize).toBeDefined();
      expect(success).toBeDefined();
      expect(metadata).toBeDefined();
      expect(source).toBeDefined();
    });

    it('IngestAdapterOptionsの型が正しく動作する', async () => {
      // 型チェック（コンパイル時に検証される）
      const options = {
        url: 'https://example.com',
        fullPage: true,
        viewport: { width: 1920, height: 1080 },
        waitForSelector: '.content',
        timeout: 30000,
        disableJavaScript: false,
        waitUntil: 'load' as const,
        skipScreenshot: false,
        sourceType: 'user_provided' as const,
        usageScope: 'inspiration_only' as const,
      };

      const result = await pageIngestAdapter.ingest(options);
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // 13. ブラウザ起動オプションテスト
  // =====================================================
  describe('ブラウザ起動オプション', () => {
    it('セキュリティ関連の起動オプションが設定される', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining([
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            // v0.1.0: --no-sandboxを削除、--gpu-sandbox-start-earlyを追加
            '--gpu-sandbox-start-early',
          ]),
        })
      );
    });

    it('--no-sandboxが含まれないこと（セキュリティ強化）', async () => {
      await pageIngestAdapter.ingest({ url: 'https://example.com' });

      const launchCall = mockLaunch.mock.calls[0][0];
      expect(launchCall.args).not.toContain('--no-sandbox');
    });
  });

  // =====================================================
  // 14. waitForLoadingElementHiddenテスト
  // =====================================================
  describe('waitForLoadingElementHidden', () => {
    it('waitForSelectorHiddenが指定された場合にローディング要素の非表示を待機する', async () => {
      // page.evaluateでローディング要素チェックが呼ばれることを検証
      let loadingCheckCalled = false;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('isElementHidden')) {
          loadingCheckCalled = true;
          return Promise.resolve({
            hidden: true,
            waitTime: 100,
            reason: 'became_hidden',
          });
        }
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({
            title: 'Test Page',
            description: 'Test description',
            ogImage: undefined,
            favicon: undefined,
            lang: 'en',
            canonical: undefined,
            keywords: undefined,
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
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForSelectorHidden: '.loading',
      });

      expect(loadingCheckCalled).toBe(true);
    });

    it('複数のセレクターをカンマ区切りで処理する', async () => {
      let passedSelectors: string[] = [];
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('isElementHidden')) {
          // スクリプト内からセレクター配列を抽出
          const match = script.match(/var selectors = (\[.*?\]);/);
          if (match) {
            passedSelectors = JSON.parse(match[1]) as string[];
          }
          return Promise.resolve({
            hidden: true,
            waitTime: 50,
            reason: 'already_hidden',
          });
        }
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({
            title: 'Test Page',
            description: undefined,
            ogImage: undefined,
            favicon: undefined,
            lang: undefined,
            canonical: undefined,
            keywords: undefined,
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
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForSelectorHidden: '.loading, .loader, [data-loading]',
      });

      expect(passedSelectors).toEqual(['.loading', '.loader', '[data-loading]']);
    });

    it('ローディング要素が既に非表示の場合はalready_hiddenを返す', async () => {
      let loadingResult: { hidden: boolean; reason: string } | null = null;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('isElementHidden')) {
          loadingResult = {
            hidden: true,
            waitTime: 0,
            reason: 'already_hidden',
          };
          return Promise.resolve(loadingResult);
        }
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({
            title: 'Test Page',
            description: undefined,
            ogImage: undefined,
            favicon: undefined,
            lang: undefined,
            canonical: undefined,
            keywords: undefined,
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
        return Promise.resolve({});
      });

      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForSelectorHidden: '.loading',
      });

      expect(result.success).toBe(true);
      expect(loadingResult?.reason).toBe('already_hidden');
    });

    it('タイムアウト時はhidden: falseを返す', async () => {
      let loadingResult: { hidden: boolean; reason: string } | null = null;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('isElementHidden')) {
          loadingResult = {
            hidden: false,
            waitTime: 15000,
            reason: 'timeout',
          };
          return Promise.resolve(loadingResult);
        }
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({
            title: 'Test Page',
            description: undefined,
            ogImage: undefined,
            favicon: undefined,
            lang: undefined,
            canonical: undefined,
            keywords: undefined,
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
        return Promise.resolve({});
      });

      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForSelectorHidden: '.loading',
      });

      // タイムアウトしてもingestは成功する（ローディング要素が残っていてもHTMLは取得される）
      expect(result.success).toBe(true);
      expect(loadingResult?.reason).toBe('timeout');
      expect(loadingResult?.hidden).toBe(false);
    });

    it('waitForSelectorHiddenが未指定の場合はローディングチェックをスキップする', async () => {
      let loadingCheckCalled = false;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('isElementHidden')) {
          loadingCheckCalled = true;
          return Promise.resolve({ hidden: true, waitTime: 0, reason: 'already_hidden' });
        }
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
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        // waitForSelectorHiddenを指定しない
      });

      expect(loadingCheckCalled).toBe(false);
    });
  });

  // =====================================================
  // 15. simulateUserInteractionテスト
  // =====================================================
  describe('simulateUserInteraction', () => {
    beforeEach(() => {
      // マウス操作のモックを追加
      mockPage.mouse = {
        move: vi.fn().mockResolvedValue(undefined),
        wheel: vi.fn().mockResolvedValue(undefined),
      };
      mockPage.viewportSize = vi.fn().mockReturnValue({ width: 1440, height: 900 });
      mockPage.waitForTimeout = vi.fn().mockResolvedValue(undefined);
    });

    it('デフォルトでユーザーインタラクションが模倣される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(mockPage.mouse.move).toHaveBeenCalled();
      expect(mockPage.mouse.wheel).toHaveBeenCalled();
    });

    it('ビューポート中央にマウスを移動する', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(mockPage.mouse.move).toHaveBeenCalledWith(720, 450); // 1440/2, 900/2
    });

    it('スクロールが実行される（下→上）', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 100);
      expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, -100);
    });

    it('simulateUserInteraction: falseでインタラクションをスキップ', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        simulateUserInteraction: false,
      });

      expect(mockPage.mouse.move).not.toHaveBeenCalled();
      expect(mockPage.mouse.wheel).not.toHaveBeenCalled();
    });

    it('インタラクションエラーでもingestは成功する', async () => {
      mockPage.mouse.move.mockRejectedValueOnce(new Error('Mouse error'));

      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
    });

    it('viewportSizeがnullの場合はデフォルト値を使用', async () => {
      mockPage.viewportSize.mockReturnValueOnce(null);

      await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      // デフォルト値（1440/2, 900/2）でmoveが呼ばれる
      expect(mockPage.mouse.move).toHaveBeenCalledWith(720, 450);
    });
  });

  // =====================================================
  // 16. waitForContentVisibleテスト
  // =====================================================
  describe('waitForContentVisible', () => {
    it('waitForContentVisibleが指定された場合にコンテンツの可視性を待機する', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForContentVisible: 'h1, section',
      });

      expect(mockPage.waitForSelector).toHaveBeenCalledWith(
        'h1, section',
        expect.objectContaining({
          state: 'visible',
        })
      );
    });

    it('waitForContentVisibleが未指定の場合はスキップ', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      // waitForSelector自体は呼ばれない（waitForSelectorオプションも未指定の場合）
      // または、state: 'visible'での呼び出しがない
      const visibleCalls = mockPage.waitForSelector.mock.calls.filter(
        (call: unknown[]) => call[1]?.state === 'visible'
      );
      expect(visibleCalls).toHaveLength(0);
    });

    it('コンテンツ要素が見つからなくてもingestは成功する', async () => {
      mockPage.waitForSelector.mockRejectedValueOnce(new Error('Timeout'));

      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForContentVisible: 'h1.nonexistent',
      });

      expect(result.success).toBe(true);
    });

    it('コンテンツ可視化のタイムアウトは全体タイムアウトの半分以下', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        timeout: 60000,
        waitForContentVisible: 'h1',
      });

      expect(mockPage.waitForSelector).toHaveBeenCalledWith(
        'h1',
        expect.objectContaining({
          timeout: 30000, // min(60000/2, 30000)
        })
      );
    });
  });

  // =====================================================
  // 17. DOM安定化待機テスト（waitForDomStable）
  // =====================================================
  describe('waitForDomStable', () => {
    it('デフォルトでDOM安定化待機が有効', async () => {
      let domStableCheckCalled = false;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          domStableCheckCalled = true;
          return Promise.resolve({
            stable: true,
            mutations: 5,
            waitTime: 500,
            reason: 'dom_stable',
          });
        }
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({
            title: 'Test Page',
            description: 'Test description',
            ogImage: undefined,
            favicon: undefined,
            lang: undefined,
            canonical: undefined,
            keywords: undefined,
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
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://example.com',
      });

      expect(domStableCheckCalled).toBe(true);
    });

    it('waitForDomStable: falseでDOM安定化待機をスキップ', async () => {
      let domStableCheckCalled = false;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          domStableCheckCalled = true;
          return Promise.resolve({ stable: true, mutations: 0, waitTime: 0 });
        }
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
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForDomStable: false,
      });

      expect(domStableCheckCalled).toBe(false);
    });

    it('domStableTimeoutオプションが適用される', async () => {
      let capturedTimeout = 0;
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('MutationObserver')) {
          const match = script.match(/const stableTimeout = (\d+);/);
          if (match) {
            capturedTimeout = parseInt(match[1], 10);
          }
          return Promise.resolve({
            stable: true,
            mutations: 0,
            waitTime: 1000,
            reason: 'dom_stable',
          });
        }
        if (typeof script === 'string' && script.includes('title')) {
          return Promise.resolve({
            title: 'Test Page',
            description: undefined,
            ogImage: undefined,
            favicon: undefined,
            lang: undefined,
            canonical: undefined,
            keywords: undefined,
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
        return Promise.resolve({});
      });

      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        domStableTimeout: 1000,
      });

      expect(capturedTimeout).toBe(1000);
    });
  });

  // =====================================================
  // 18. waitForTimeoutテスト（追加固定待機）
  // =====================================================
  describe('waitForTimeout', () => {
    beforeEach(() => {
      mockPage.waitForTimeout = vi.fn().mockResolvedValue(undefined);
    });

    it('waitForTimeoutが指定された場合に追加待機が実行される', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForTimeout: 2000,
      });

      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(2000);
    });

    it('waitForTimeout: 0の場合は追加待機をスキップ', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        waitForTimeout: 0,
      });

      // simulateUserInteractionの500ms待機以外は呼ばれない
      // waitForTimeout: 0は「追加待機なし」
      const calls = mockPage.waitForTimeout.mock.calls.filter(
        (call: unknown[]) => call[0] === 0
      );
      expect(calls).toHaveLength(0);
    });

    it('waitForTimeoutが未指定の場合は追加待機をスキップ', async () => {
      await pageIngestAdapter.ingest({
        url: 'https://example.com',
        // waitForTimeoutを指定しない
      });

      // simulateUserInteractionの500ms以外に呼ばれていないことを確認
      const longWaitCalls = mockPage.waitForTimeout.mock.calls.filter(
        (call: unknown[]) => (call[0] as number) > 500
      );
      expect(longWaitCalls).toHaveLength(0);
    });
  });

  // =====================================================
  // 19. Computed Stylesテスト
  // =====================================================
  describe('includeComputedStyles', () => {
    const mockComputedStylesResult = [
      {
        index: 0,
        tagName: 'HEADER',
        className: 'site-header',
        id: 'main-header',
        role: 'banner',
        styles: {
          backgroundColor: 'rgb(255, 255, 255)',
          backgroundImage: 'none',
          color: 'rgb(0, 0, 0)',
          fontSize: '16px',
          fontFamily: 'system-ui, sans-serif',
          fontWeight: '400',
          lineHeight: '1.5',
          letterSpacing: 'normal',
          textAlign: 'left',
          textDecoration: 'none',
          textTransform: 'none',
          display: 'flex',
          position: 'relative',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px',
          paddingTop: '16px',
          paddingRight: '16px',
          paddingBottom: '16px',
          paddingLeft: '16px',
          margin: '0px',
          marginTop: '0px',
          marginRight: '0px',
          marginBottom: '0px',
          marginLeft: '0px',
          gap: '0px',
          width: '1920px',
          height: '80px',
          maxWidth: 'none',
          minHeight: 'auto',
          border: '0px none rgb(0, 0, 0)',
          borderRadius: '0px',
          boxShadow: 'none',
          backdropFilter: 'none',
          opacity: '1',
          overflow: 'visible',
          transition: 'none',
          transform: 'none',
        },
        children: [
          {
            selector: 'h1.site-title',
            tagName: 'H1',
            className: 'site-title',
            path: 'div > h1',
            textContent: 'Example Site',
            styles: {
              backgroundColor: 'transparent',
              backgroundImage: 'none',
              color: 'rgb(51, 51, 51)',
              fontSize: '24px',
              fontFamily: 'system-ui, sans-serif',
              fontWeight: '700',
              lineHeight: '1.2',
              letterSpacing: '-0.5px',
              textAlign: 'left',
              textDecoration: 'none',
              textTransform: 'none',
              display: 'block',
              position: 'static',
              flexDirection: 'row',
              justifyContent: 'normal',
              alignItems: 'normal',
              padding: '0px',
              paddingTop: '0px',
              paddingRight: '0px',
              paddingBottom: '0px',
              paddingLeft: '0px',
              margin: '0px',
              marginTop: '0px',
              marginRight: '0px',
              marginBottom: '0px',
              marginLeft: '0px',
              gap: 'normal',
              width: 'auto',
              height: 'auto',
              maxWidth: 'none',
              minHeight: 'auto',
              border: '0px none rgb(51, 51, 51)',
              borderRadius: '0px',
              boxShadow: 'none',
              backdropFilter: 'none',
              opacity: '1',
              overflow: 'visible',
              transition: 'none',
              transform: 'none',
            },
          },
        ],
      },
    ];

    beforeEach(() => {
      // Computed Styles取得用のevaluateモック
      mockPage.evaluate.mockImplementation((script: string) => {
        if (typeof script === 'string' && script.includes('getElementStyles')) {
          return Promise.resolve(mockComputedStylesResult);
        }
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
        return Promise.resolve({});
      });
    });

    it('includeComputedStyles: trueでComputed Stylesが取得される', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        includeComputedStyles: true,
      });

      expect(result.success).toBe(true);
      expect(result.computedStyles).toBeDefined();
      expect(result.computedStyles).toHaveLength(1);
    });

    it('Computed Stylesにセクション情報が含まれる', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        includeComputedStyles: true,
      });

      expect(result.success).toBe(true);
      const section = result.computedStyles?.[0];
      expect(section?.tagName).toBe('HEADER');
      expect(section?.className).toBe('site-header');
      expect(section?.id).toBe('main-header');
      expect(section?.role).toBe('banner');
    });

    it('Computed Stylesにスタイル情報が含まれる', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        includeComputedStyles: true,
      });

      expect(result.success).toBe(true);
      const styles = result.computedStyles?.[0]?.styles;
      expect(styles?.display).toBe('flex');
      expect(styles?.backgroundColor).toBe('rgb(255, 255, 255)');
      expect(styles?.fontSize).toBe('16px');
      expect(styles?.padding).toBe('16px');
    });

    it('Computed Stylesに子要素情報が含まれる', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        includeComputedStyles: true,
      });

      expect(result.success).toBe(true);
      const children = result.computedStyles?.[0]?.children;
      expect(children).toBeDefined();
      expect(children).toHaveLength(1);
      expect(children?.[0]?.tagName).toBe('H1');
      expect(children?.[0]?.textContent).toBe('Example Site');
    });

    it('includeComputedStyles: falseの場合はComputed Stylesを取得しない', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        includeComputedStyles: false,
      });

      expect(result.success).toBe(true);
      expect(result.computedStyles).toBeUndefined();
    });

    it('includeComputedStylesが未指定の場合はデフォルトでfalse', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        // includeComputedStylesを指定しない
      });

      expect(result.success).toBe(true);
      expect(result.computedStyles).toBeUndefined();
    });

    it('拡張されたスタイルプロパティが含まれる', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        includeComputedStyles: true,
      });

      expect(result.success).toBe(true);
      const styles = result.computedStyles?.[0]?.styles;
      // 拡張されたプロパティ
      expect(styles?.textAlign).toBe('left');
      expect(styles?.textDecoration).toBe('none');
      expect(styles?.textTransform).toBe('none');
      expect(styles?.position).toBe('relative');
      expect(styles?.flexDirection).toBe('row');
      expect(styles?.justifyContent).toBe('space-between');
      expect(styles?.alignItems).toBe('center');
      expect(styles?.paddingTop).toBe('16px');
      expect(styles?.width).toBe('1920px');
      expect(styles?.border).toBeDefined();
      expect(styles?.overflow).toBe('visible');
    });

    it('子要素のpath情報が含まれる', async () => {
      const result = await pageIngestAdapter.ingest({
        url: 'https://example.com',
        includeComputedStyles: true,
      });

      expect(result.success).toBe(true);
      const child = result.computedStyles?.[0]?.children?.[0];
      expect(child?.path).toBe('div > h1');
      expect(child?.selector).toBe('h1.site-title');
    });
  });
});
