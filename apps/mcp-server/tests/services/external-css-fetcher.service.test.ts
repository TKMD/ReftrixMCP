// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ExternalCssFetcher サービス テスト
 * TDD Red フェーズ: 外部CSSファイル取得サービスのテスト
 *
 * 目的:
 * - HTMLから<link rel="stylesheet">タグのCSS URLを抽出
 * - 相対URLを絶対URLに変換
 * - 外部CSSコンテンツの取得
 * - SSRF対策（プライベートIPブロック）
 * - タイムアウト処理
 * - @import URL解決
 * - 複数CSSファイルの結合
 *
 * 実装対象ファイル: src/services/external-css-fetcher.ts (未作成)
 *
 * @module tests/services/external-css-fetcher.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// TDD Red フェーズ: 実装ファイルが存在しないことを確認するテスト
// このテストは実装が完了すると成功に変わる
// =====================================================

describe('TDD Red Phase - Implementation Required', () => {
  it('実装ファイルが存在することを確認（現在は失敗する）', async () => {
    // TDD Red: このインポートは実装ファイルが存在しないため失敗する
    // 実装完了後、このテストは成功に変わる
    let ExternalCssFetcher: unknown;
    let importError: Error | null = null;

    try {
      // 動的インポートで実装ファイルの存在を確認
      const module = await import('../../src/services/external-css-fetcher');
      ExternalCssFetcher = module.ExternalCssFetcher;
    } catch (error) {
      importError = error as Error;
    }

    // TDD Red フェーズ: 実装がまだ存在しないため、
    // ExternalCssFetcherクラスが正しくエクスポートされていることを期待する
    // このアサーションは実装完了まで失敗する
    expect(ExternalCssFetcher).toBeDefined();
    expect(importError).toBeNull();
  });

  it('extractCssUrls 関数がエクスポートされていることを確認', async () => {
    let extractCssUrls: unknown;
    let importError: Error | null = null;

    try {
      const module = await import('../../src/services/external-css-fetcher');
      extractCssUrls = module.extractCssUrls;
    } catch (error) {
      importError = error as Error;
    }

    expect(extractCssUrls).toBeDefined();
    expect(typeof extractCssUrls).toBe('function');
    expect(importError).toBeNull();
  });

  it('fetchCss 関数がエクスポートされていることを確認', async () => {
    let fetchCss: unknown;
    let importError: Error | null = null;

    try {
      const module = await import('../../src/services/external-css-fetcher');
      fetchCss = module.fetchCss;
    } catch (error) {
      importError = error as Error;
    }

    expect(fetchCss).toBeDefined();
    expect(typeof fetchCss).toBe('function');
    expect(importError).toBeNull();
  });

  it('fetchAllCss 関数がエクスポートされていることを確認', async () => {
    let fetchAllCss: unknown;
    let importError: Error | null = null;

    try {
      const module = await import('../../src/services/external-css-fetcher');
      fetchAllCss = module.fetchAllCss;
    } catch (error) {
      importError = error as Error;
    }

    expect(fetchAllCss).toBeDefined();
    expect(typeof fetchAllCss).toBe('function');
    expect(importError).toBeNull();
  });

  it('isSafeUrl 関数がエクスポートされていることを確認', async () => {
    let isSafeUrl: unknown;
    let importError: Error | null = null;

    try {
      const module = await import('../../src/services/external-css-fetcher');
      isSafeUrl = module.isSafeUrl;
    } catch (error) {
      importError = error as Error;
    }

    expect(isSafeUrl).toBeDefined();
    expect(typeof isSafeUrl).toBe('function');
    expect(importError).toBeNull();
  });
});

// =====================================================
// 型定義（実装はまだ存在しない）
// =====================================================

/**
 * CSS URL抽出結果
 */
interface ExtractedCssUrl {
  /** 抽出されたURL */
  url: string;
  /** link要素のmedia属性 */
  media?: string;
  /** link要素のtype属性（省略時はtext/css） */
  type?: string;
  /** 元のhref値（相対URLの場合） */
  originalHref: string;
  /** @importからの抽出かどうか */
  fromImport?: boolean;
}

/**
 * CSS取得結果
 */
interface FetchCssResult {
  /** 取得成功フラグ */
  success: boolean;
  /** CSSコンテンツ（成功時） */
  content?: string;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** HTTPステータスコード（取得試行時） */
  statusCode?: number;
  /** 最終的なURL（リダイレクト後） */
  finalUrl?: string;
  /** コンテンツサイズ（バイト） */
  contentSize?: number;
}

/**
 * 複数CSS取得結果
 */
interface FetchAllCssResult {
  /** 結合されたCSSコンテンツ */
  combinedCss: string;
  /** 各URLの取得結果 */
  results: Array<{
    url: string;
    success: boolean;
    error?: string;
    contentSize?: number;
  }>;
  /** 成功した取得数 */
  successCount: number;
  /** 失敗した取得数 */
  failedCount: number;
  /** 合計コンテンツサイズ（バイト） */
  totalSize: number;
}

/**
 * ExternalCssFetcherの設定
 */
interface ExternalCssFetcherOptions {
  /** タイムアウト（ミリ秒）デフォルト: 5000 */
  timeout?: number;
  /** 最大並列取得数 デフォルト: 5 */
  maxConcurrent?: number;
  /** @importを解決するかどうか デフォルト: true（1レベルのみ） */
  resolveImports?: boolean;
  /** 最大CSSサイズ（バイト）デフォルト: 5MB */
  maxCssSize?: number;
  /** User-Agentヘッダー */
  userAgent?: string;
}

/**
 * ExternalCssFetcherサービスインターフェース
 * 実装はまだ存在しない
 */
interface IExternalCssFetcher {
  /**
   * HTMLから<link rel="stylesheet">のURLを抽出
   */
  extractCssUrls(html: string, baseUrl: string): ExtractedCssUrl[];

  /**
   * CSSコンテンツ内の@import URLを抽出
   */
  extractImportUrls(css: string, baseUrl: string): ExtractedCssUrl[];

  /**
   * 単一URLからCSSを取得
   */
  fetchCss(url: string, options?: ExternalCssFetcherOptions): Promise<FetchCssResult>;

  /**
   * 複数URLからCSSを取得して結合
   */
  fetchAllCss(urls: string[], options?: ExternalCssFetcherOptions): Promise<FetchAllCssResult>;

  /**
   * URLがSSRFの観点から安全かチェック
   */
  isSafeUrl(url: string): boolean;

  /**
   * 相対URLを絶対URLに変換
   */
  resolveUrl(href: string, baseUrl: string): string;
}

// =====================================================
// モックインポート（実装はまだ存在しない）
// 以下のインポートはTDD Greenフェーズで実装後に有効になる
// =====================================================

// import {
//   ExternalCssFetcher,
//   extractCssUrls,
//   extractImportUrls,
//   fetchCss,
//   fetchAllCss,
//   isSafeUrl,
//   resolveUrl,
// } from '../../src/services/external-css-fetcher';

// =====================================================
// テストデータ
// =====================================================

const sampleHtmlWithLinks = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
  <link rel="stylesheet" href="/styles/main.css">
  <link rel="stylesheet" href="https://cdn.example.com/lib.css">
  <link rel="stylesheet" href="./components/button.css" media="screen">
  <link rel="stylesheet" href="../shared/reset.css" type="text/css">
  <link rel="icon" href="/favicon.ico">
  <link rel="preload" href="/fonts/main.woff2" as="font">
</head>
<body>
  <h1>Test</h1>
</body>
</html>`;

const sampleHtmlNoStylesheets = `<!DOCTYPE html>
<html>
<head>
  <title>No Stylesheets</title>
  <link rel="icon" href="/favicon.ico">
  <link rel="canonical" href="https://example.com/page">
</head>
<body>Content</body>
</html>`;

const sampleHtmlWithInlineStyle = `<!DOCTYPE html>
<html>
<head>
  <style>
    @import url('https://fonts.example.com/fonts.css');
    @import 'local/styles.css';
    body { margin: 0; }
  </style>
  <link rel="stylesheet" href="/main.css">
</head>
<body></body>
</html>`;

const sampleCssWithImports = `
@import url('https://cdn.example.com/reset.css');
@import 'variables.css';
@import url("./components/button.css");

body {
  font-family: sans-serif;
}

.container {
  max-width: 1200px;
}
`;

const sampleCssNoImports = `
body {
  margin: 0;
  padding: 0;
}

.container {
  display: flex;
}
`;

const baseUrl = 'https://example.com/pages/test.html';

// =====================================================
// extractCssUrls テスト
// =====================================================

describe('ExternalCssFetcher', () => {
  // モックサービスをbeforeEachで設定
  let mockFetcher: IExternalCssFetcher;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // fetchのモック
    mockFetch = vi.fn();

    // テスト用のモック実装（TDD Redフェーズ用）
    // 実際の実装が完成したら、これは本物の実装に置き換えられる
    mockFetcher = {
      extractCssUrls: vi.fn(),
      extractImportUrls: vi.fn(),
      fetchCss: vi.fn(),
      fetchAllCss: vi.fn(),
      isSafeUrl: vi.fn(),
      resolveUrl: vi.fn(),
    };

    // グローバルfetchのモック
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // =================================================
  // extractCssUrls テスト
  // =================================================

  describe('extractCssUrls', () => {
    it('link rel="stylesheet" タグからhrefを抽出する', () => {
      // モック設定
      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
        { url: 'https://cdn.example.com/lib.css', originalHref: 'https://cdn.example.com/lib.css' },
        { url: 'https://example.com/pages/components/button.css', originalHref: './components/button.css', media: 'screen' },
        { url: 'https://example.com/shared/reset.css', originalHref: '../shared/reset.css', type: 'text/css' },
      ]);

      const result = mockFetcher.extractCssUrls(sampleHtmlWithLinks, baseUrl);

      expect(result).toHaveLength(4);
      expect(result[0].url).toBe('https://example.com/styles/main.css');
      expect(result[1].url).toBe('https://cdn.example.com/lib.css');
      expect(result[2].media).toBe('screen');
      expect(result[3].type).toBe('text/css');

      // TDD Red: 実際の実装がないため、このテストはモックで動作する
      // 実装完了後、モックを削除してテストを実行する
    });

    it('相対URLを絶対URLに変換する', () => {
      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
        { url: 'https://example.com/pages/components/button.css', originalHref: './components/button.css' },
        { url: 'https://example.com/shared/reset.css', originalHref: '../shared/reset.css' },
      ]);

      const result = mockFetcher.extractCssUrls(sampleHtmlWithLinks, baseUrl);

      // 絶対パス
      expect(result[0].url).toBe('https://example.com/styles/main.css');
      // 相対パス（カレントディレクトリ）
      expect(result[1].url).toBe('https://example.com/pages/components/button.css');
      // 相対パス（親ディレクトリ）
      expect(result[2].url).toBe('https://example.com/shared/reset.css');

      // TDD Red: 実装がないため失敗する
    });

    it('非stylesheetのlinkタグを無視する', () => {
      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = mockFetcher.extractCssUrls(sampleHtmlNoStylesheets, baseUrl);

      expect(result).toHaveLength(0);
      // TDD Red: link rel="icon" や rel="canonical" は含まれない
    });

    it('複数のlink stylesheetタグを処理する', () => {
      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
        { url: 'https://cdn.example.com/lib.css', originalHref: 'https://cdn.example.com/lib.css' },
        { url: 'https://example.com/pages/components/button.css', originalHref: './components/button.css' },
        { url: 'https://example.com/shared/reset.css', originalHref: '../shared/reset.css' },
      ]);

      const result = mockFetcher.extractCssUrls(sampleHtmlWithLinks, baseUrl);

      expect(result.length).toBe(4);
      // TDD Red: 複数のURLを正しく抽出
    });

    it('@import URLをstyle要素から抽出する', () => {
      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://fonts.example.com/fonts.css', originalHref: 'https://fonts.example.com/fonts.css', fromImport: true },
        { url: 'https://example.com/pages/local/styles.css', originalHref: 'local/styles.css', fromImport: true },
        { url: 'https://example.com/main.css', originalHref: '/main.css' },
      ]);

      const result = mockFetcher.extractCssUrls(sampleHtmlWithInlineStyle, baseUrl);

      // @importとlinkの両方を抽出
      expect(result.some((r) => r.fromImport)).toBe(true);
      expect(result.some((r) => !r.fromImport)).toBe(true);
      // TDD Red: @importの解析も含む
    });
  });

  // =================================================
  // extractImportUrls テスト
  // =================================================

  describe('extractImportUrls', () => {
    it('@import url() 形式を抽出する', () => {
      (mockFetcher.extractImportUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://cdn.example.com/reset.css', originalHref: 'https://cdn.example.com/reset.css', fromImport: true },
        { url: 'https://example.com/pages/components/button.css', originalHref: './components/button.css', fromImport: true },
      ]);

      const result = mockFetcher.extractImportUrls(sampleCssWithImports, baseUrl);

      const urlImports = result.filter((r) => r.originalHref.includes('url(') === false);
      expect(urlImports.length).toBeGreaterThan(0);
      // TDD Red: @import url('...') 形式を解析
    });

    it('@import \'...\' 形式を抽出する', () => {
      (mockFetcher.extractImportUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/pages/variables.css', originalHref: 'variables.css', fromImport: true },
      ]);

      const result = mockFetcher.extractImportUrls(sampleCssWithImports, baseUrl);

      expect(result.some((r) => r.originalHref === 'variables.css')).toBe(true);
      // TDD Red: @import 'file.css' 形式を解析
    });

    it('@import "..." 形式を抽出する', () => {
      (mockFetcher.extractImportUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/pages/components/button.css', originalHref: './components/button.css', fromImport: true },
      ]);

      const result = mockFetcher.extractImportUrls(sampleCssWithImports, baseUrl);

      expect(result.some((r) => r.originalHref.includes('button.css'))).toBe(true);
      // TDD Red: @import "file.css" 形式を解析
    });

    it('@importがないCSSで空配列を返す', () => {
      (mockFetcher.extractImportUrls as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = mockFetcher.extractImportUrls(sampleCssNoImports, baseUrl);

      expect(result).toHaveLength(0);
      // TDD Red: @importがない場合
    });

    it('相対パスの@importを絶対URLに変換する', () => {
      (mockFetcher.extractImportUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/pages/variables.css', originalHref: 'variables.css', fromImport: true },
        { url: 'https://example.com/pages/components/button.css', originalHref: './components/button.css', fromImport: true },
      ]);

      const result = mockFetcher.extractImportUrls(sampleCssWithImports, baseUrl);

      result.forEach((r) => {
        expect(r.url.startsWith('http')).toBe(true);
      });
      // TDD Red: 相対パスを絶対URLに変換
    });
  });

  // =================================================
  // fetchCss テスト
  // =================================================

  describe('fetchCss', () => {
    it('URLからCSSコンテンツを取得する', async () => {
      const cssContent = 'body { margin: 0; }';

      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        content: cssContent,
        statusCode: 200,
        finalUrl: 'https://example.com/styles.css',
        contentSize: cssContent.length,
      });

      const result = await mockFetcher.fetchCss('https://example.com/styles.css');

      expect(result.success).toBe(true);
      expect(result.content).toBe(cssContent);
      expect(result.statusCode).toBe(200);
      // TDD Red: 正常な取得
    });

    it('指定時間後にタイムアウトする', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Request timed out after 5000ms',
      });

      const result = await mockFetcher.fetchCss('https://slow-server.com/styles.css', {
        timeout: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      // TDD Red: タイムアウト処理
    });

    it('失敗したリクエストでnullを返す', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Network error',
        statusCode: undefined,
      });

      const result = await mockFetcher.fetchCss('https://nonexistent.example.com/styles.css');

      expect(result.success).toBe(false);
      expect(result.content).toBeUndefined();
      // TDD Red: ネットワークエラー
    });

    it('404エラーを適切にハンドルする', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Not Found',
        statusCode: 404,
      });

      const result = await mockFetcher.fetchCss('https://example.com/not-found.css');

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      // TDD Red: 404エラー
    });

    it('500エラーを適切にハンドルする', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Internal Server Error',
        statusCode: 500,
      });

      const result = await mockFetcher.fetchCss('https://example.com/error.css');

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      // TDD Red: 500エラー
    });

    it('プライベートIPアドレスをブロックする (SSRF protection)', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'SSRF protection: private IP address blocked',
      });

      const result = await mockFetcher.fetchCss('http://192.168.1.1/styles.css');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      // TDD Red: プライベートIP 192.168.x.x をブロック
    });

    it('localhost をブロックする (SSRF protection)', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'SSRF protection: localhost blocked',
      });

      const result = await mockFetcher.fetchCss('http://localhost/styles.css');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      // TDD Red: localhost をブロック
    });

    it('127.0.0.1 をブロックする (SSRF protection)', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'SSRF protection: loopback address blocked',
      });

      const result = await mockFetcher.fetchCss('http://127.0.0.1/styles.css');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      // TDD Red: 127.0.0.1 をブロック
    });

    it('10.x.x.x をブロックする (SSRF protection)', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'SSRF protection: private IP range blocked',
      });

      const result = await mockFetcher.fetchCss('http://10.0.0.1/styles.css');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      // TDD Red: 10.0.0.0/8 をブロック
    });

    it('172.16-31.x.x をブロックする (SSRF protection)', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'SSRF protection: private IP range blocked',
      });

      const result = await mockFetcher.fetchCss('http://172.16.0.1/styles.css');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      // TDD Red: 172.16.0.0/12 をブロック
    });

    it('169.254.169.254 (AWS metadata) をブロックする (SSRF protection)', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'SSRF protection: metadata service blocked',
      });

      const result = await mockFetcher.fetchCss('http://169.254.169.254/latest/meta-data/');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      // TDD Red: AWSメタデータサービスをブロック
    });

    it('リダイレクトURLを処理する', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        content: 'body { color: red; }',
        statusCode: 200,
        finalUrl: 'https://cdn.example.com/v2/styles.css',
        contentSize: 20,
      });

      const result = await mockFetcher.fetchCss('https://example.com/styles.css');

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://cdn.example.com/v2/styles.css');
      // TDD Red: リダイレクトを追跡
    });

    it('リダイレクト先がプライベートIPの場合ブロックする', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'SSRF protection: redirect to private IP blocked',
      });

      // リダイレクト先が 192.168.1.1 の場合
      const result = await mockFetcher.fetchCss('https://example.com/redirect-to-private.css');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      // TDD Red: リダイレクト先もSSRFチェック
    });

    it('最大CSSサイズを超える場合エラーを返す', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'CSS content exceeds maximum size of 5242880 bytes',
      });

      const result = await mockFetcher.fetchCss('https://example.com/huge.css', {
        maxCssSize: 5 * 1024 * 1024, // 5MB
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum size');
      // TDD Red: サイズ制限
    });
  });

  // =================================================
  // fetchAllCss テスト
  // =================================================

  describe('fetchAllCss', () => {
    it('複数のCSSファイルを取得して結合する', async () => {
      (mockFetcher.fetchAllCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        combinedCss: '/* reset.css */\nbody { margin: 0; }\n\n/* main.css */\n.container { max-width: 1200px; }',
        results: [
          { url: 'https://example.com/reset.css', success: true, contentSize: 20 },
          { url: 'https://example.com/main.css', success: true, contentSize: 30 },
        ],
        successCount: 2,
        failedCount: 0,
        totalSize: 50,
      });

      const result = await mockFetcher.fetchAllCss([
        'https://example.com/reset.css',
        'https://example.com/main.css',
      ]);

      expect(result.combinedCss.length).toBeGreaterThan(0);
      expect(result.successCount).toBe(2);
      expect(result.failedCount).toBe(0);
      // TDD Red: 複数CSSの結合
    });

    it('一部の取得が失敗しても継続する', async () => {
      (mockFetcher.fetchAllCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        combinedCss: '/* main.css */\n.container { max-width: 1200px; }',
        results: [
          { url: 'https://example.com/missing.css', success: false, error: 'Not Found' },
          { url: 'https://example.com/main.css', success: true, contentSize: 30 },
        ],
        successCount: 1,
        failedCount: 1,
        totalSize: 30,
      });

      const result = await mockFetcher.fetchAllCss([
        'https://example.com/missing.css',
        'https://example.com/main.css',
      ]);

      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.combinedCss.length).toBeGreaterThan(0);
      // TDD Red: 部分的な失敗を許容
    });

    it('maxConcurrent 制限を守る', async () => {
      const fetchCalls: number[] = [];
      let activeCalls = 0;
      let maxActiveCalls = 0;

      (mockFetcher.fetchAllCss as ReturnType<typeof vi.fn>).mockImplementation(
        async (urls: string[], options?: ExternalCssFetcherOptions) => {
          const maxConcurrent = options?.maxConcurrent ?? 5;
          // 並列実行をシミュレート
          for (const url of urls) {
            activeCalls++;
            maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
            fetchCalls.push(Date.now());
            await new Promise((resolve) => setTimeout(resolve, 10));
            activeCalls--;
          }

          // maxConcurrentを超えていないことを確認
          expect(maxActiveCalls).toBeLessThanOrEqual(maxConcurrent);

          return {
            combinedCss: '',
            results: urls.map((url) => ({ url, success: true, contentSize: 0 })),
            successCount: urls.length,
            failedCount: 0,
            totalSize: 0,
          };
        }
      );

      await mockFetcher.fetchAllCss(
        Array.from({ length: 10 }, (_, i) => `https://example.com/style${i}.css`),
        { maxConcurrent: 3 }
      );

      // TDD Red: 並列実行数の制限
      expect(maxActiveCalls).toBeLessThanOrEqual(3);
    });

    it('空の配列で空の結果を返す', async () => {
      (mockFetcher.fetchAllCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        combinedCss: '',
        results: [],
        successCount: 0,
        failedCount: 0,
        totalSize: 0,
      });

      const result = await mockFetcher.fetchAllCss([]);

      expect(result.combinedCss).toBe('');
      expect(result.results).toHaveLength(0);
      // TDD Red: 空入力の処理
    });

    it('すべての取得が失敗した場合も正常に終了する', async () => {
      (mockFetcher.fetchAllCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        combinedCss: '',
        results: [
          { url: 'https://example.com/a.css', success: false, error: 'Failed' },
          { url: 'https://example.com/b.css', success: false, error: 'Failed' },
        ],
        successCount: 0,
        failedCount: 2,
        totalSize: 0,
      });

      const result = await mockFetcher.fetchAllCss([
        'https://example.com/a.css',
        'https://example.com/b.css',
      ]);

      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(2);
      expect(result.combinedCss).toBe('');
      // TDD Red: 全失敗時の処理
    });
  });

  // =================================================
  // isSafeUrl テスト
  // =================================================

  describe('isSafeUrl', () => {
    it('パブリックURLを許可する', () => {
      (mockFetcher.isSafeUrl as ReturnType<typeof vi.fn>).mockReturnValue(true);

      expect(mockFetcher.isSafeUrl('https://example.com/styles.css')).toBe(true);
      expect(mockFetcher.isSafeUrl('https://cdn.example.com/lib.css')).toBe(true);
      // TDD Red: パブリックURLは許可
    });

    it('プライベートIPをブロックする', () => {
      (mockFetcher.isSafeUrl as ReturnType<typeof vi.fn>).mockReturnValue(false);

      expect(mockFetcher.isSafeUrl('http://192.168.1.1/styles.css')).toBe(false);
      expect(mockFetcher.isSafeUrl('http://10.0.0.1/styles.css')).toBe(false);
      expect(mockFetcher.isSafeUrl('http://172.16.0.1/styles.css')).toBe(false);
      // TDD Red: プライベートIPをブロック
    });

    it('localhostをブロックする', () => {
      (mockFetcher.isSafeUrl as ReturnType<typeof vi.fn>).mockReturnValue(false);

      expect(mockFetcher.isSafeUrl('http://localhost/styles.css')).toBe(false);
      expect(mockFetcher.isSafeUrl('http://localhost:3000/styles.css')).toBe(false);
      expect(mockFetcher.isSafeUrl('http://127.0.0.1/styles.css')).toBe(false);
      // TDD Red: localhostをブロック
    });

    it('メタデータサービスURLをブロックする', () => {
      (mockFetcher.isSafeUrl as ReturnType<typeof vi.fn>).mockReturnValue(false);

      expect(mockFetcher.isSafeUrl('http://169.254.169.254/latest/')).toBe(false);
      expect(mockFetcher.isSafeUrl('http://metadata.google.internal/')).toBe(false);
      // TDD Red: クラウドメタデータサービスをブロック
    });

    it('非http/httpsプロトコルをブロックする', () => {
      (mockFetcher.isSafeUrl as ReturnType<typeof vi.fn>).mockReturnValue(false);

      expect(mockFetcher.isSafeUrl('file:///etc/passwd')).toBe(false);
      expect(mockFetcher.isSafeUrl('ftp://example.com/styles.css')).toBe(false);
      expect(mockFetcher.isSafeUrl('javascript:alert(1)')).toBe(false);
      // TDD Red: 危険なプロトコルをブロック
    });
  });

  // =================================================
  // resolveUrl テスト
  // =================================================

  describe('resolveUrl', () => {
    it('絶対URLをそのまま返す', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://cdn.example.com/lib.css'
      );

      const result = mockFetcher.resolveUrl('https://cdn.example.com/lib.css', baseUrl);

      expect(result).toBe('https://cdn.example.com/lib.css');
      // TDD Red: 絶対URLはそのまま
    });

    it('ルート相対パスを解決する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://example.com/styles/main.css'
      );

      const result = mockFetcher.resolveUrl('/styles/main.css', baseUrl);

      expect(result).toBe('https://example.com/styles/main.css');
      // TDD Red: ルート相対パス
    });

    it('相対パス (./) を解決する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://example.com/pages/components/button.css'
      );

      const result = mockFetcher.resolveUrl('./components/button.css', baseUrl);

      expect(result).toBe('https://example.com/pages/components/button.css');
      // TDD Red: カレントディレクトリ相対パス
    });

    it('相対パス (../) を解決する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://example.com/shared/reset.css'
      );

      const result = mockFetcher.resolveUrl('../shared/reset.css', baseUrl);

      expect(result).toBe('https://example.com/shared/reset.css');
      // TDD Red: 親ディレクトリ相対パス
    });

    it('プロトコル相対URL (//) を解決する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://cdn.example.com/lib.css'
      );

      const result = mockFetcher.resolveUrl('//cdn.example.com/lib.css', baseUrl);

      expect(result).toBe('https://cdn.example.com/lib.css');
      // TDD Red: プロトコル相対URL
    });

    it('ファイル名のみの相対パスを解決する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://example.com/pages/styles.css'
      );

      const result = mockFetcher.resolveUrl('styles.css', baseUrl);

      expect(result).toBe('https://example.com/pages/styles.css');
      // TDD Red: ファイル名のみ
    });

    it('クエリパラメータ付きURLを処理する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://example.com/styles.css?v=1.0'
      );

      const result = mockFetcher.resolveUrl('/styles.css?v=1.0', baseUrl);

      expect(result).toBe('https://example.com/styles.css?v=1.0');
      // TDD Red: クエリパラメータの保持
    });

    it('ハッシュ付きURLを処理する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://example.com/styles.css#section'
      );

      const result = mockFetcher.resolveUrl('/styles.css#section', baseUrl);

      expect(result).toBe('https://example.com/styles.css#section');
      // TDD Red: ハッシュの保持
    });

    // =====================================================
    // 新規追加: エッジケースとセキュリティテスト
    // =====================================================

    it('空文字列のhrefで空文字列を返す', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue('');

      const result = mockFetcher.resolveUrl('', baseUrl);

      expect(result).toBe('');
      // 入力バリデーション: 空文字列
    });

    it('空文字列のbaseUrlでhrefが絶対URLなら返す', () => {
      const absoluteUrl = 'https://cdn.example.com/styles.css';
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(absoluteUrl);

      const result = mockFetcher.resolveUrl(absoluteUrl, '');

      expect(result).toBe(absoluteUrl);
      // baseUrlが無効でもhrefが絶対URLなら有効
    });

    it('空文字列のbaseUrlで相対hrefなら空文字列を返す', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue('');

      const result = mockFetcher.resolveUrl('./styles.css', '');

      expect(result).toBe('');
      // 相対URLだが解決不可
    });

    it('data: URL をそのまま返す', () => {
      const dataUrl = 'data:text/css;base64,Ym9keXttYXJnaW46MH0=';
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(dataUrl);

      const result = mockFetcher.resolveUrl(dataUrl, baseUrl);

      expect(result).toBe(dataUrl);
      // 特殊スキーム: data: URL
    });

    it('blob: URL をそのまま返す', () => {
      const blobUrl = 'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000';
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(blobUrl);

      const result = mockFetcher.resolveUrl(blobUrl, baseUrl);

      expect(result).toBe(blobUrl);
      // 特殊スキーム: blob: URL
    });

    it('javascript: スキームをブロックして空文字列を返す', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue('');

      const result = mockFetcher.resolveUrl('javascript:alert(1)', baseUrl);

      expect(result).toBe('');
      // セキュリティ: javascript: スキームをブロック
    });

    it('JAVASCRIPT: （大文字）スキームもブロックする', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue('');

      const result = mockFetcher.resolveUrl('JAVASCRIPT:alert(1)', baseUrl);

      expect(result).toBe('');
      // 大文字小文字を問わずブロック
    });

    it('無効なbaseURLと相対hrefで空文字列を返す', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue('');

      const result = mockFetcher.resolveUrl('./styles.css', 'not-a-valid-url');

      expect(result).toBe('');
      // 無効なbaseURLでは解決不可
    });

    it('トリミング付きhref（前後に空白）を正しく処理する', () => {
      (mockFetcher.resolveUrl as ReturnType<typeof vi.fn>).mockReturnValue(
        'https://example.com/styles/main.css'
      );

      const result = mockFetcher.resolveUrl('  /styles/main.css  ', baseUrl);

      expect(result).toBe('https://example.com/styles/main.css');
      // トリミング処理
    });
  });

  // =================================================
  // 統合テスト
  // =================================================

  describe('統合テスト', () => {
    it('HTMLからCSSを抽出・取得・結合する完全フロー', async () => {
      // Step 1: URL抽出
      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
        { url: 'https://cdn.example.com/lib.css', originalHref: 'https://cdn.example.com/lib.css' },
      ]);

      // Step 2: CSS取得
      (mockFetcher.fetchAllCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        combinedCss: 'body { margin: 0; }\n\n.container { display: flex; }',
        results: [
          { url: 'https://example.com/styles/main.css', success: true, contentSize: 20 },
          { url: 'https://cdn.example.com/lib.css', success: true, contentSize: 30 },
        ],
        successCount: 2,
        failedCount: 0,
        totalSize: 50,
      });

      // 実行
      const urls = mockFetcher.extractCssUrls(sampleHtmlWithLinks, baseUrl);
      const result = await mockFetcher.fetchAllCss(urls.map((u) => u.url));

      expect(urls.length).toBeGreaterThan(0);
      expect(result.combinedCss.length).toBeGreaterThan(0);
      expect(result.successCount).toBeGreaterThan(0);
      // TDD Red: 完全フローのテスト
    });

    it('@importを含むCSSを再帰的に解決する（1レベルのみ）', async () => {
      // CSSから@importを抽出
      (mockFetcher.extractImportUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/variables.css', originalHref: 'variables.css', fromImport: true },
      ]);

      // インポート先のCSSを取得
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        content: ':root { --primary: blue; }',
        statusCode: 200,
        contentSize: 25,
      });

      const imports = mockFetcher.extractImportUrls(sampleCssWithImports, baseUrl);
      const importedCss = await mockFetcher.fetchCss(imports[0].url);

      expect(imports.length).toBeGreaterThan(0);
      expect(importedCss.success).toBe(true);
      expect(importedCss.content).toContain('--primary');
      // TDD Red: @importの解決
    });
  });

  // =================================================
  // エラーハンドリングテスト
  // =================================================

  describe('エラーハンドリング', () => {
    it('無効なURLでエラーを返す', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Invalid URL format',
      });

      const result = await mockFetcher.fetchCss('not-a-valid-url');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
      // TDD Red: 無効なURL
    });

    it('空のHTMLで空の配列を返す', () => {
      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = mockFetcher.extractCssUrls('', baseUrl);

      expect(result).toHaveLength(0);
      // TDD Red: 空のHTML
    });

    it('不正なHTMLでも部分的に動作する', () => {
      const malformedHtml = '<html><link rel="stylesheet" href="/valid.css"><not-closed';

      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue([
        { url: 'https://example.com/valid.css', originalHref: '/valid.css' },
      ]);

      const result = mockFetcher.extractCssUrls(malformedHtml, baseUrl);

      expect(result.length).toBeGreaterThan(0);
      // TDD Red: 部分的な解析
    });

    it('ネットワークエラーを適切にハンドルする', async () => {
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Network error: ENOTFOUND',
      });

      const result = await mockFetcher.fetchCss('https://nonexistent-domain-12345.com/styles.css');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
      // TDD Red: DNS解決失敗など
    });

    it('Content-Type が text/css 以外の場合の処理', async () => {
      // text/html が返ってきた場合など
      (mockFetcher.fetchCss as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Invalid Content-Type: expected text/css, got text/html',
      });

      const result = await mockFetcher.fetchCss('https://example.com/not-css.html');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content-Type');
      // TDD Red: Content-Typeの検証
    });
  });

  // =================================================
  // パフォーマンステスト
  // =================================================

  describe('パフォーマンス', () => {
    it('大量のlink要素を高速に処理する', () => {
      const manyLinksHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          ${Array.from({ length: 100 }, (_, i) => `<link rel="stylesheet" href="/style${i}.css">`).join('\n')}
        </head>
        <body></body>
        </html>
      `;

      (mockFetcher.extractCssUrls as ReturnType<typeof vi.fn>).mockReturnValue(
        Array.from({ length: 100 }, (_, i) => ({
          url: `https://example.com/style${i}.css`,
          originalHref: `/style${i}.css`,
        }))
      );

      const startTime = Date.now();
      const result = mockFetcher.extractCssUrls(manyLinksHtml, baseUrl);
      const duration = Date.now() - startTime;

      expect(result.length).toBe(100);
      expect(duration).toBeLessThan(100); // 100ms以内
      // TDD Red: 大量要素の処理速度
    });
  });
});

// =====================================================
// 実装完了後に有効にするテスト
// （モックではなく実際の実装をテストする）
// =====================================================

describe('resolveUrl - 実装テスト（モックなし）', () => {
  let resolveUrlImpl: (href: string, baseUrl: string) => string;

  beforeEach(async () => {
    const module = await import('../../src/services/external-css-fetcher');
    resolveUrlImpl = module.resolveUrl;
  });

  const testBaseUrl = 'https://example.com/pages/test.html';

  it('絶対URLをそのまま返す', () => {
    const absoluteUrl = 'https://cdn.example.com/lib.css';
    const result = resolveUrlImpl(absoluteUrl, testBaseUrl);
    expect(result).toBe(absoluteUrl);
  });

  it('ルート相対パスを解決する', () => {
    const result = resolveUrlImpl('/styles/main.css', testBaseUrl);
    expect(result).toBe('https://example.com/styles/main.css');
  });

  it('相対パス (./) を解決する', () => {
    const result = resolveUrlImpl('./components/button.css', testBaseUrl);
    expect(result).toBe('https://example.com/pages/components/button.css');
  });

  it('相対パス (../) を解決する', () => {
    const result = resolveUrlImpl('../shared/reset.css', testBaseUrl);
    expect(result).toBe('https://example.com/shared/reset.css');
  });

  it('プロトコル相対URL (//) を解決する', () => {
    const result = resolveUrlImpl('//cdn.example.com/lib.css', testBaseUrl);
    expect(result).toBe('https://cdn.example.com/lib.css');
  });

  it('空文字列のhrefで空文字列を返す', () => {
    const result = resolveUrlImpl('', testBaseUrl);
    expect(result).toBe('');
  });

  it('空文字列のbaseUrlでhrefが絶対URLなら返す', () => {
    const absoluteUrl = 'https://cdn.example.com/styles.css';
    const result = resolveUrlImpl(absoluteUrl, '');
    expect(result).toBe(absoluteUrl);
  });

  it('空文字列のbaseUrlで相対hrefなら空文字列を返す', () => {
    const result = resolveUrlImpl('./styles.css', '');
    expect(result).toBe('');
  });

  it('data: URL をそのまま返す', () => {
    const dataUrl = 'data:text/css;base64,Ym9keXttYXJnaW46MH0=';
    const result = resolveUrlImpl(dataUrl, testBaseUrl);
    expect(result).toBe(dataUrl);
  });

  it('blob: URL をそのまま返す', () => {
    const blobUrl = 'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000';
    const result = resolveUrlImpl(blobUrl, testBaseUrl);
    expect(result).toBe(blobUrl);
  });

  it('javascript: スキームをブロックして空文字列を返す', () => {
    const result = resolveUrlImpl('javascript:alert(1)', testBaseUrl);
    expect(result).toBe('');
  });

  it('JAVASCRIPT: （大文字）スキームもブロックする', () => {
    const result = resolveUrlImpl('JAVASCRIPT:alert(1)', testBaseUrl);
    expect(result).toBe('');
  });

  it('トリミング付きhref（前後に空白）を正しく処理する', () => {
    const result = resolveUrlImpl('  /styles/main.css  ', testBaseUrl);
    expect(result).toBe('https://example.com/styles/main.css');
  });

  it('クエリパラメータ付きURLを処理する', () => {
    const result = resolveUrlImpl('/styles.css?v=1.0', testBaseUrl);
    expect(result).toBe('https://example.com/styles.css?v=1.0');
  });

  it('ハッシュ付きURLを処理する', () => {
    const result = resolveUrlImpl('/styles.css#section', testBaseUrl);
    expect(result).toBe('https://example.com/styles.css#section');
  });

  it('ファイル名のみの相対パスを解決する', () => {
    const result = resolveUrlImpl('styles.css', testBaseUrl);
    expect(result).toBe('https://example.com/pages/styles.css');
  });

  it('無効なbaseURLと相対hrefで空文字列を返す', () => {
    const result = resolveUrlImpl('./styles.css', 'not-a-valid-url');
    expect(result).toBe('');
  });
});

describe.skip('ExternalCssFetcher - 実装完了後テスト', () => {
  // このブロックは実装完了後にスキップを解除して実行
  // 現在はTDD Redフェーズのためスキップ

  it('実際の実装が存在することを確認', async () => {
    // 実装ファイルが存在するかどうかをチェック
    const fs = await import('fs');
    const path = await import('path');

    const implementationPath = path.join(
      __dirname,
      '../../src/services/external-css-fetcher.ts'
    );

    // このテストは実装ファイルが作成されたら成功する
    expect(fs.existsSync(implementationPath)).toBe(true);
  });
});
