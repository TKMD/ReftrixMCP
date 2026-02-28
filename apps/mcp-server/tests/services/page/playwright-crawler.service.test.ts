// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlaywrightCrawler サービス テスト
 * TDD: Playwrightを使用したWebクローリングサービスのテスト
 *
 * 目的:
 * - Playwrightでwebページをクロールしhtml/スクリーンショットを取得
 * - SSRF対策（プライベートIP、メタデータサービスをブロック）
 * - タイムアウト処理
 * - viewportサイズ設定
 * - waitUntilオプション対応
 *
 * @module tests/services/page/playwright-crawler.service.test
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  PlaywrightCrawlerService,
  crawlPage,
  closeSharedService,
  DEFAULT_CRAWL_OPTIONS,
  SSRFBlockedError,
  InvalidProtocolError,
  CrawlError,
} from '../../../src/services/page/playwright-crawler.service';

// テスト終了後に共有サービスをクリーンアップ
afterAll(async () => {
  await closeSharedService();
});

// =====================================================
// Unit Tests - ネットワークアクセス不要
// =====================================================

describe('PlaywrightCrawlerService - Unit Tests', () => {
  describe('Module Exports', () => {
    it('PlaywrightCrawlerService クラスがエクスポートされていること', () => {
      expect(PlaywrightCrawlerService).toBeDefined();
      expect(typeof PlaywrightCrawlerService).toBe('function');
    });

    it('crawlPage 関数がエクスポートされていること', () => {
      expect(crawlPage).toBeDefined();
      expect(typeof crawlPage).toBe('function');
    });

    it('closeSharedService 関数がエクスポートされていること', () => {
      expect(closeSharedService).toBeDefined();
      expect(typeof closeSharedService).toBe('function');
    });

    it('DEFAULT_CRAWL_OPTIONS がエクスポートされていること', () => {
      expect(DEFAULT_CRAWL_OPTIONS).toBeDefined();
    });

    it('エラークラスがエクスポートされていること', () => {
      expect(SSRFBlockedError).toBeDefined();
      expect(InvalidProtocolError).toBeDefined();
      expect(CrawlError).toBeDefined();
    });
  });

  describe('DEFAULT_CRAWL_OPTIONS', () => {
    it('デフォルトタイムアウトが30000msであること', () => {
      expect(DEFAULT_CRAWL_OPTIONS.timeout).toBe(30000);
    });

    it('デフォルトwaitUntilがdomcontentloadedであること（WebGL/3Dサイト対応）', () => {
      // WebGL/3Dサイトでは'load'イベントが非常に遅いため、'domcontentloaded'をデフォルトに変更
      expect(DEFAULT_CRAWL_OPTIONS.waitUntil).toBe('domcontentloaded');
    });

    it('デフォルトviewportが1440x900であること', () => {
      expect(DEFAULT_CRAWL_OPTIONS.viewport).toEqual({ width: 1440, height: 900 });
    });
  });

  describe('PlaywrightCrawlerService Class', () => {
    it('インスタンスを作成できること', () => {
      const service = new PlaywrightCrawlerService();
      expect(service).toBeInstanceOf(PlaywrightCrawlerService);
    });

    it('crawlメソッドが存在すること', () => {
      const service = new PlaywrightCrawlerService();
      expect(typeof service.crawl).toBe('function');
    });

    it('closeメソッドが存在すること', () => {
      const service = new PlaywrightCrawlerService();
      expect(typeof service.close).toBe('function');
    });
  });

  describe('SSRF Protection - Synchronous Validation', () => {
    it('プライベートIP (10.x.x.x) がブロックされること', async () => {
      await expect(crawlPage('http://10.0.0.1/api', { timeout: 5000 })).rejects.toThrow(
        SSRFBlockedError
      );
    });

    it('プライベートIP (172.16-31.x.x) がブロックされること', async () => {
      await expect(crawlPage('http://172.16.0.1/api', { timeout: 5000 })).rejects.toThrow(
        SSRFBlockedError
      );
    });

    it('プライベートIP (192.168.x.x) がブロックされること', async () => {
      await expect(crawlPage('http://192.168.1.1/api', { timeout: 5000 })).rejects.toThrow(
        SSRFBlockedError
      );
    });

    it('localhost (127.x.x.x) がブロックされること', async () => {
      await expect(crawlPage('http://127.0.0.1:3000', { timeout: 5000 })).rejects.toThrow(
        SSRFBlockedError
      );
    });

    it('リンクローカル (169.254.x.x) がブロックされること', async () => {
      await expect(crawlPage('http://169.254.1.1/api', { timeout: 5000 })).rejects.toThrow(
        SSRFBlockedError
      );
    });

    it('AWSメタデータサービス (169.254.169.254) がブロックされること', async () => {
      await expect(
        crawlPage('http://169.254.169.254/latest/meta-data/', { timeout: 5000 })
      ).rejects.toThrow(SSRFBlockedError);
    });

    it('localhost ホスト名がブロックされること', async () => {
      await expect(crawlPage('http://localhost:3000/api', { timeout: 5000 })).rejects.toThrow(
        SSRFBlockedError
      );
    });
  });

  describe('Protocol Validation', () => {
    it('fileプロトコルがブロックされること', async () => {
      await expect(crawlPage('file:///etc/passwd', { timeout: 5000 })).rejects.toThrow(
        InvalidProtocolError
      );
    });

    it('ftpプロトコルがブロックされること', async () => {
      await expect(crawlPage('ftp://example.com/file', { timeout: 5000 })).rejects.toThrow(
        InvalidProtocolError
      );
    });

    it('javascriptプロトコルがブロックされること', async () => {
      await expect(
        crawlPage('javascript:alert(1)', { timeout: 5000 })
      ).rejects.toThrow();
    });

    it('dataプロトコルがブロックされること', async () => {
      await expect(
        crawlPage('data:text/html,<h1>test</h1>', { timeout: 5000 })
      ).rejects.toThrow();
    });
  });

  describe('Invalid URL Handling', () => {
    it('無効なURLでエラーをスローすること', async () => {
      await expect(crawlPage('not-a-valid-url', { timeout: 5000 })).rejects.toThrow(CrawlError);
    });

    it('空のURLでエラーをスローすること', async () => {
      await expect(crawlPage('', { timeout: 5000 })).rejects.toThrow();
    });

    it('プロトコルなしのURLでエラーをスローすること', async () => {
      await expect(crawlPage('example.com', { timeout: 5000 })).rejects.toThrow();
    });
  });

  describe('Error Classes', () => {
    it('SSRFBlockedError が正しい名前を持つこと', () => {
      const error = new SSRFBlockedError('test');
      expect(error.name).toBe('SSRFBlockedError');
      expect(error.message).toBe('test');
    });

    it('InvalidProtocolError が正しい名前を持つこと', () => {
      const error = new InvalidProtocolError('test');
      expect(error.name).toBe('InvalidProtocolError');
      expect(error.message).toBe('test');
    });

    it('CrawlError が正しい名前とステータスコードを持つこと', () => {
      const error = new CrawlError('test', 404);
      expect(error.name).toBe('CrawlError');
      expect(error.message).toBe('test');
      expect(error.statusCode).toBe(404);
    });
  });
});

// =====================================================
// withTimeout Operation Protection Tests
// =====================================================

describe('PlaywrightCrawlerService - withTimeout Protection', () => {
  const crawlerSourcePath = require('node:path').resolve(
    __dirname,
    '../../../src/services/page/playwright-crawler.service.ts'
  );
  const crawlerSource = require('node:fs').readFileSync(crawlerSourcePath, 'utf8');

  it('should wrap page.content() with withTimeout', () => {
    expect(crawlerSource).toContain("withTimeout(\n        page.content(),");
    expect(crawlerSource).toContain("'page.content()'");
  });

  it('should wrap page.screenshot() with withTimeout', () => {
    expect(crawlerSource).toContain("'page.screenshot()'");
  });

  it('should use crawl options timeout as operation timeout', () => {
    expect(crawlerSource).toContain('const operationTimeout = opts.timeout ?? 30000');
  });

  it('should import withTimeout from timeout-utils', () => {
    expect(crawlerSource).toMatch(/import\s+\{[^}]*withTimeout[^}]*\}\s+from/);
  });
});

// =====================================================
// Integration Tests - ネットワークアクセスが必要
// Playwrightブラウザが必要なため、CI環境では実行時間が長くなる可能性あり
// =====================================================

describe('PlaywrightCrawlerService - Integration Tests', () => {
  // テスト用のサービスインスタンス
  let service: PlaywrightCrawlerService;

  afterAll(async () => {
    if (service) {
      await service.close();
    }
  });

  describe('Basic Crawling', () => {
    it('example.comからHTMLを取得できること', async () => {
      const result = await crawlPage('https://example.com', {
        timeout: 30000,
        waitUntil: 'load',
      });

      expect(result).toHaveProperty('html');
      // doctypeは大文字小文字どちらでも許容
      expect(result.html.toLowerCase()).toContain('<!doctype html>');
      expect(result.html.toLowerCase()).toContain('example');
    }, 60000);

    it('HTMLからtitleを抽出すること', async () => {
      const result = await crawlPage('https://example.com', {
        timeout: 30000,
      });

      expect(result.title).toBeDefined();
      expect(typeof result.title).toBe('string');
      expect(result.title?.toLowerCase()).toContain('example');
    }, 60000);

    it('スクリーンショットをbase64で返すこと', async () => {
      const result = await crawlPage('https://example.com', {
        timeout: 30000,
      });

      expect(result.screenshot).toBeDefined();
      expect(typeof result.screenshot).toBe('string');
      // base64の形式チェック（PNG画像のbase64は特定のパターンで始まる）
      expect(result.screenshot!.length).toBeGreaterThan(100);
    }, 60000);
  });

  describe('Options Handling', () => {
    it('カスタムviewportが適用されること', async () => {
      const result = await crawlPage('https://example.com', {
        timeout: 30000,
        viewport: { width: 1920, height: 1080 },
      });

      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('screenshot');
    }, 60000);

    it('waitUntil: networkidleオプションが適用されること', async () => {
      const result = await crawlPage('https://example.com', {
        timeout: 30000,
        waitUntil: 'networkidle',
      });

      expect(result).toHaveProperty('html');
    }, 60000);

    it('waitUntil: domcontentloadedオプションが適用されること', async () => {
      const result = await crawlPage('https://example.com', {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      });

      expect(result).toHaveProperty('html');
    }, 60000);
  });

  describe('Protocol Support', () => {
    it('httpsプロトコルが許可されること', async () => {
      const result = await crawlPage('https://example.com', {
        timeout: 30000,
      });

      expect(result).toHaveProperty('html');
    }, 60000);

    it('httpプロトコルが許可されること', async () => {
      const result = await crawlPage('http://example.com', {
        timeout: 30000,
      });

      expect(result).toHaveProperty('html');
    }, 60000);
  });

  describe('Error Handling - Network', () => {
    it('タイムアウト時にエラーをスローすること', async () => {
      // 非常に短いタイムアウトで確実にタイムアウトさせる
      await expect(crawlPage('https://example.com', { timeout: 1 })).rejects.toThrow(CrawlError);
    }, 30000);

    it('存在しないドメインでエラーをスローすること', async () => {
      await expect(
        crawlPage('https://this-domain-definitely-does-not-exist-12345.com', {
          timeout: 10000,
        })
      ).rejects.toThrow(CrawlError);
    }, 30000);
  });

  describe('HTTP Status Codes', () => {
    it('404レスポンスでエラーをスローすること', async () => {
      await expect(
        crawlPage('https://httpstat.us/404', { timeout: 30000 })
      ).rejects.toThrow(CrawlError);
    }, 60000);

    it('500レスポンスでエラーをスローすること', async () => {
      await expect(
        crawlPage('https://httpstat.us/500', { timeout: 30000 })
      ).rejects.toThrow(CrawlError);
    }, 60000);
  });

  describe('PlaywrightCrawlerService Instance', () => {
    it('インスタンスメソッドでクロールできること', async () => {
      service = new PlaywrightCrawlerService();
      const result = await service.crawl('https://example.com', {
        timeout: 30000,
      });

      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('screenshot');
    }, 60000);

    it('closeメソッドが正常に動作すること', async () => {
      const testService = new PlaywrightCrawlerService();
      await testService.crawl('https://example.com', { timeout: 30000 });
      await expect(testService.close()).resolves.not.toThrow();
    }, 60000);
  });
});
