// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.ingest 外部CSS URL事前抽出テスト
 *
 * DOMPurifyでサニタイズする前に外部CSS URLを抽出し、
 * LayoutAnalyzerServiceにpreExtractedUrlsとして渡すことを検証するテスト
 *
 * 問題背景:
 * - DOMPurifyはHTMLをサニタイズする際に<link>タグを除去する
 * - sanitizeHtml()の後にLayoutAnalyzerService.analyze()が呼ばれると
 *   外部CSSのURLを抽出できない
 *
 * 解決策:
 * - sanitizeHtml()を呼び出す前に、生のHTMLからCSS URLを抽出
 * - 抽出したURLをpreExtractedUrlsとしてLayoutAnalyzerServiceに渡す
 *
 * @module tests/tools/layout/ingest-pre-extracted-css.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoistedでモック関数を先に定義（ホイスティング対策）
const {
  mockValidateExternalUrl,
  mockSanitizeHtml,
  mockIngest,
  mockUpsert,
  mockAnalyze,
  mockGenerateEmbedding,
  mockSaveSectionWithEmbedding,
  mockAnalyzeHtml,
} = vi.hoisted(() => ({
  mockValidateExternalUrl: vi.fn(),
  mockSanitizeHtml: vi.fn(),
  mockIngest: vi.fn(),
  mockUpsert: vi.fn(),
  mockAnalyze: vi.fn(),
  mockGenerateEmbedding: vi.fn(),
  mockSaveSectionWithEmbedding: vi.fn(),
  mockAnalyzeHtml: vi.fn(),
}));

// Prismaモック
vi.mock('@reftrix/database', () => ({
  prisma: {
    webPage: {
      upsert: mockUpsert,
    },
  },
}));

// loggerモック
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  isDevelopment: () => true,
}));

// url-validatorモック
vi.mock('../../../src/utils/url-validator', () => ({
  validateExternalUrl: mockValidateExternalUrl,
}));

// html-sanitizerモック（サニタイズで<link>タグを除去）
vi.mock('../../../src/utils/html-sanitizer', () => ({
  sanitizeHtml: mockSanitizeHtml,
}));

// page-ingest-adapterモック
vi.mock('../../../src/services/page-ingest-adapter', () => ({
  pageIngestAdapter: {
    ingest: mockIngest,
  },
}));

// LayoutAnalyzerServiceモック
vi.mock('../../../src/services/page/layout-analyzer.service', () => ({
  getLayoutAnalyzerService: vi.fn(() => ({
    analyze: mockAnalyze,
  })),
}));

import {
  layoutIngestHandler,
  setLayoutIngestServiceFactory,
  resetLayoutIngestServiceFactory,
} from '../../../src/tools/layout/ingest.tool';

// テスト用のHTML（<link>タグを含む）
const HTML_WITH_EXTERNAL_CSS = `
<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <link rel="stylesheet" href="/styles/main.css">
  <link rel="stylesheet" href="https://example.com/theme.css">
  <link rel="stylesheet" href="./relative/path.css">
</head>
<body>
  <section class="hero">
    <h1>Welcome</h1>
  </section>
</body>
</html>
`;

// DOMPurifyでサニタイズされた後のHTML（<link>タグが除去される）
const SANITIZED_HTML_WITHOUT_LINK_TAGS = `
<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
</head>
<body>
  <section class="hero">
    <h1>Welcome</h1>
  </section>
</body>
</html>
`;

describe('layout.ingest 外部CSS URL事前抽出', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルトモック設定
    mockValidateExternalUrl.mockReturnValue({
      valid: true,
      normalizedUrl: 'https://example.com/',
    });

    // サニタイズで<link>タグを除去するモック
    // 重要: これによりサニタイズ後のHTMLからはCSS URLが抽出できなくなる
    mockSanitizeHtml.mockImplementation(() => SANITIZED_HTML_WITHOUT_LINK_TAGS);

    // 生のHTMLを返すインジェストモック
    mockIngest.mockResolvedValue({
      success: true,
      html: HTML_WITH_EXTERNAL_CSS,
      screenshots: [],
      metadata: {
        title: 'Test Page',
        description: 'Test description',
        favicon: 'https://example.com/favicon.ico',
      },
      source: {
        type: 'user_provided',
        usageScope: 'inspiration_only',
      },
      ingestedAt: new Date('2025-01-01T00:00:00Z'),
    });

    // DB保存モック
    mockUpsert.mockResolvedValue({ id: 'test-web-page-id' });

    // LayoutAnalyzerServiceモック
    mockAnalyze.mockResolvedValue({
      success: true,
      sections: [{
        id: 'section-1',
        type: 'hero',
        confidence: 0.95,
        position: { startY: 0, endY: 100, height: 100 },
        content: {
          headings: [{ level: 1, text: 'Welcome' }],
        },
      }],
      sectionCount: 1,
      sectionTypes: { hero: 1 },
      processingTimeMs: 100,
      externalCssFetch: {
        successCount: 3,
        failedCount: 0,
        totalSize: 1024,
        processingTimeMs: 200,
        results: [],
      },
    });

    // analyzeHtmlモック（IngestServiceFactory経由）
    mockAnalyzeHtml.mockResolvedValue({
      sections: [{
        id: 'section-1',
        type: 'hero',
        confidence: 0.95,
        position: { startY: 0, endY: 100, height: 100 },
      }],
      sectionCount: 1,
      sectionTypes: { hero: 1 },
    });

    mockGenerateEmbedding.mockResolvedValue(Array(768).fill(0.1));
    mockSaveSectionWithEmbedding.mockResolvedValue('section-embed-id');

    // IngestServiceFactoryを設定
    // auto_analyze: trueの場合、このファクトリが返すサービスが使用される
    setLayoutIngestServiceFactory(() => ({
      analyzeHtml: mockAnalyzeHtml,
      saveSectionWithEmbedding: mockSaveSectionWithEmbedding,
      generateEmbedding: mockGenerateEmbedding,
    }));
  });

  afterEach(() => {
    vi.resetAllMocks();
    resetLayoutIngestServiceFactory();
  });

  describe('外部CSS URL抽出タイミング', () => {
    it('サニタイズ前に外部CSS URLを抽出すること', async () => {
      // TDD Red Phase:
      // 現在の実装ではサニタイズ後にLayoutAnalyzerService.analyze()が呼ばれるため、
      // <link>タグが除去されてしまいCSS URLを抽出できない
      // この テストは実装が修正されるまで失敗する

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      expect(result.success).toBe(true);

      // mockAnalyzeが呼ばれた引数を確認
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
      const analyzeCallArgs = mockAnalyze.mock.calls[0];
      const analyzeOptions = analyzeCallArgs[1];

      // 検証: preExtractedUrlsが渡されていること
      // 現在の実装では渡されていないため、このテストは失敗する
      expect(analyzeOptions?.externalCss?.preExtractedUrls).toBeDefined();
      expect(analyzeOptions?.externalCss?.preExtractedUrls).toBeInstanceOf(Array);
      expect(analyzeOptions?.externalCss?.preExtractedUrls?.length).toBeGreaterThan(0);
    });

    it('抽出されたURLが正しく絶対URLに解決されていること', async () => {
      // TDD Red Phase:
      // 相対URLも含めて、すべて絶対URLに変換されていることを確認

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);

      const analyzeOptions = mockAnalyze.mock.calls[0][1];
      const preExtractedUrls = analyzeOptions?.externalCss?.preExtractedUrls;

      // 期待されるURL（相対URLは絶対URLに変換）
      expect(preExtractedUrls).toContain('https://example.com/styles/main.css');
      expect(preExtractedUrls).toContain('https://example.com/theme.css');
      expect(preExtractedUrls).toContain('https://example.com/relative/path.css');
    });

    it('外部CSS取得が成功すること', async () => {
      // TDD Red Phase:
      // preExtractedUrlsを使用して外部CSSが正しく取得されることを確認

      mockAnalyze.mockResolvedValue({
        success: true,
        sections: [{
          id: 'section-1',
          type: 'hero',
          confidence: 0.95,
          position: { startY: 0, endY: 100, height: 100 },
        }],
        sectionCount: 1,
        sectionTypes: { hero: 1 },
        processingTimeMs: 100,
        externalCssContent: '/* main.css content */',
        externalCssMeta: {
          fetchedCount: 3,
          failedCount: 0,
          totalSize: 1024,
          urls: [
            { url: 'https://example.com/styles/main.css', size: 500, success: true },
            { url: 'https://example.com/theme.css', size: 300, success: true },
            { url: 'https://example.com/relative/path.css', size: 224, success: true },
          ],
          fetchedAt: new Date().toISOString(),
        },
        externalCssFetch: {
          successCount: 3,
          failedCount: 0,
          totalSize: 1024,
          processingTimeMs: 200,
          results: [],
        },
      });

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      expect(result.success).toBe(true);

      // preExtractedUrlsが渡されていることを確認
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
      const analyzeOptions = mockAnalyze.mock.calls[0][1];
      expect(analyzeOptions?.externalCss?.preExtractedUrls).toBeDefined();

      // 成功レスポンスを検証
      if (result.success && result.data.externalCss) {
        expect(result.data.externalCss.successCount).toBe(3);
        expect(result.data.externalCss.failedCount).toBe(0);
      }
    });
  });

  describe('エッジケース', () => {
    it('HTMLに<link>タグがない場合でも正常に動作すること', async () => {
      // <link>タグのないHTML
      const htmlWithoutLinkTags = `
<!DOCTYPE html>
<html>
<head>
  <title>No External CSS</title>
  <style>.hero { color: red; }</style>
</head>
<body>
  <section class="hero"><h1>Hello</h1></section>
</body>
</html>
`;

      mockIngest.mockResolvedValueOnce({
        success: true,
        html: htmlWithoutLinkTags,
        screenshots: [],
        metadata: { title: 'No External CSS' },
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        ingestedAt: new Date(),
      });

      mockSanitizeHtml.mockImplementationOnce(() => htmlWithoutLinkTags);

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);

      // preExtractedUrlsが空配列または未定義であることを確認
      const analyzeOptions = mockAnalyze.mock.calls[0][1];
      const preExtractedUrls = analyzeOptions?.externalCss?.preExtractedUrls;
      expect(preExtractedUrls === undefined || preExtractedUrls?.length === 0).toBe(true);
    });

    it('相対パスのみの<link>タグが正しく絶対URLに変換されること', async () => {
      const htmlWithRelativeUrls = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/css/reset.css">
  <link rel="stylesheet" href="../shared/common.css">
  <link rel="stylesheet" href="./local.css">
</head>
<body><section class="hero"><h1>Hello</h1></section></body>
</html>
`;

      // 相対パス用にURL検証結果を更新
      mockValidateExternalUrl.mockReturnValue({
        valid: true,
        normalizedUrl: 'https://example.com/pages/index.html',
      });

      mockIngest.mockResolvedValueOnce({
        success: true,
        html: htmlWithRelativeUrls,
        screenshots: [],
        metadata: { title: 'Relative URLs Test' },
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        ingestedAt: new Date(),
      });

      // サニタイズで<link>タグが除去される
      mockSanitizeHtml.mockImplementationOnce(() => '<html><body></body></html>');

      const result = await layoutIngestHandler({
        url: 'https://example.com/pages/index.html',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);

      const analyzeOptions = mockAnalyze.mock.calls[0][1];
      const preExtractedUrls = analyzeOptions?.externalCss?.preExtractedUrls;

      // 相対URLが絶対URLに変換されていることを確認
      expect(preExtractedUrls).toBeDefined();
      expect(preExtractedUrls?.length).toBe(3);
      // 絶対URLの形式であること（プロトコルで始まる）
      preExtractedUrls?.forEach(url => {
        expect(url).toMatch(/^https?:\/\//);
      });
    });

    it('fetch_external_css: false の場合はexternalCssオプションがないこと', async () => {
      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: false,
        },
      });

      expect(result.success).toBe(true);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);

      const analyzeOptions = mockAnalyze.mock.calls[0][1];
      // externalCssオプション自体が存在しないこと
      expect(analyzeOptions?.externalCss).toBeUndefined();
    });

    it('auto_analyze: false の場合はLayoutAnalyzerService.analyzeが呼ばれないこと', async () => {
      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: false,
        },
      });

      expect(result.success).toBe(true);
      expect(mockAnalyze).not.toHaveBeenCalled();
    });

    it('無効なURL形式の<link>タグがあっても他のURLは正常に抽出されること', async () => {
      const htmlWithInvalidUrl = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="javascript:alert('xss')">
  <link rel="stylesheet" href="https://valid.com/style.css">
  <link rel="stylesheet" href="">
  <link rel="stylesheet" href="   ">
  <link rel="stylesheet" href="/valid/path.css">
</head>
<body></body>
</html>
`;

      mockIngest.mockResolvedValueOnce({
        success: true,
        html: htmlWithInvalidUrl,
        screenshots: [],
        metadata: { title: 'Invalid URL Test' },
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        ingestedAt: new Date(),
      });

      mockSanitizeHtml.mockImplementationOnce(() => '<html><body></body></html>');

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);

      const analyzeOptions = mockAnalyze.mock.calls[0][1];
      const preExtractedUrls = analyzeOptions?.externalCss?.preExtractedUrls;

      // 有効なURLのみが抽出されること（空やjavascript:は除外）
      expect(preExtractedUrls).toBeDefined();
      // 少なくとも有効なURL 2つは抽出される
      expect(preExtractedUrls?.length).toBeGreaterThanOrEqual(2);
      expect(preExtractedUrls).toContain('https://valid.com/style.css');
      expect(preExtractedUrls).toContain('https://example.com/valid/path.css');
      // javascript: URLは含まれないこと
      expect(preExtractedUrls?.some(url => url.includes('javascript:'))).toBe(false);
    });
  });

  describe('URLサニタイズとの連携', () => {
    it('sanitizeHtml呼び出し前に必ずURL抽出が行われること', async () => {
      // このテストは呼び出し順序を検証する
      // 期待される順序:
      // 1. mockIngest（生のHTMLを取得）
      // 2. CSS URL抽出（生のHTMLから）
      // 3. mockSanitizeHtml（HTMLをサニタイズ）
      // 4. mockAnalyze（サニタイズされたHTMLと、事前抽出したURLを渡す）

      const callOrder: string[] = [];

      mockIngest.mockImplementationOnce(async () => {
        callOrder.push('ingest');
        return {
          success: true,
          html: HTML_WITH_EXTERNAL_CSS,
          screenshots: [],
          metadata: { title: 'Test' },
          source: { type: 'user_provided', usageScope: 'inspiration_only' },
          ingestedAt: new Date(),
        };
      });

      mockSanitizeHtml.mockImplementationOnce(() => {
        callOrder.push('sanitize');
        return SANITIZED_HTML_WITHOUT_LINK_TAGS;
      });

      mockAnalyze.mockImplementationOnce(async (html, options) => {
        callOrder.push('analyze');
        // このテストでは、preExtractedUrlsが渡されていることが重要
        // サニタイズ前に抽出されていれば、URLが存在するはず
        if (options?.externalCss?.preExtractedUrls?.length) {
          callOrder.push('analyze-with-urls');
        }
        return {
          success: true,
          sections: [{
            id: 'section-1',
            type: 'hero',
            confidence: 0.95,
            position: { startY: 0, endY: 100, height: 100 },
          }],
          sectionCount: 1,
          sectionTypes: { hero: 1 },
          processingTimeMs: 100,
        };
      });

      await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      // 呼び出し順序を検証
      // 'analyze-with-urls'が存在すれば、サニタイズ前に抽出されている
      expect(callOrder).toContain('ingest');
      expect(callOrder).toContain('sanitize');
      expect(callOrder).toContain('analyze');
      // 重要: preExtractedUrlsが渡されていることを確認
      // 現在の実装では渡されていないため、このテストは失敗する
      expect(callOrder).toContain('analyze-with-urls');
    });
  });

  describe('save_to_db: false でのauto_analyze', () => {
    it('save_to_db: false の場合、auto_analyzeが無視されること', async () => {
      // save_to_db: false の場合は persistedId が undefined になるため、
      // auto_analyze: true でも LayoutAnalyzerService.analyze() は呼ばれない
      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: false,
          auto_analyze: true,
          fetch_external_css: true,
        },
      });

      expect(result.success).toBe(true);
      // save_to_db: false なので、analyzeは呼ばれない
      expect(mockAnalyze).not.toHaveBeenCalled();
    });
  });
});
