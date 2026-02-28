// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * レスポンスサイズ警告ミドルウェア統合テスト
 * server.ts との統合をテスト
 *
 * NOTE: SVG機能削除に伴い、WebDesign用ツールでテストを更新
 *
 * @module response-size-warning-integration.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { responseSizeWarning } from '../../src/middleware/response-size-warning';

// server.ts内での使用をシミュレート
describe('ResponseSizeWarning サーバー統合テスト', () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  let warnSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // コンソール出力をキャプチャ
    warnSpy = vi.fn();
    errorSpy = vi.fn();
    console.warn = warnSpy;
    console.error = errorSpy;
    // テスト環境でログを有効化
    process.env.ENABLE_TEST_LOGS = 'true';
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    delete process.env.ENABLE_TEST_LOGS;
    vi.restoreAllMocks();
  });

  describe('デフォルトインスタンス', () => {
    it('responseSizeWarning がエクスポートされていること', () => {
      expect(responseSizeWarning).toBeDefined();
      expect(typeof responseSizeWarning.checkResponseSize).toBe('function');
    });

    it('小さなレスポンスで警告が出ないこと', () => {
      const smallResponse = { id: '123', name: 'test' };
      const result = responseSizeWarning.checkResponseSize('layout.search', smallResponse);

      expect(result.exceededWarning).toBe(false);
      expect(result.exceededCritical).toBe(false);
    });

    it('大きなレスポンスで警告が出ること', () => {
      const largeData = 'x'.repeat(15 * 1024);
      const largeResponse = { data: largeData };
      const result = responseSizeWarning.checkResponseSize('layout.search', largeResponse);

      expect(result.exceededWarning).toBe(true);
      expect(result.recommendation).toBeDefined();
    });
  });

  describe('MCPツール別の動作', () => {
    it('layout.search で大きなレスポンスに includeHtml: false 推奨が出ること', () => {
      const largeData = 'x'.repeat(12 * 1024);
      const largeResponse = { results: [{ data: largeData }] };
      const result = responseSizeWarning.checkResponseSize('layout.search', largeResponse);

      expect(result.recommendation).toContain('includeHtml');
    });

    it('layout.ingest で大きなレスポンスに include_html/include_screenshot: false 推奨が出ること', () => {
      const largeData = 'x'.repeat(12 * 1024);
      const largeResponse = { html: largeData };
      const result = responseSizeWarning.checkResponseSize('layout.ingest', largeResponse);

      expect(result.recommendation).toContain('include_html: false');
    });

    it('quality.evaluate で大きなレスポンスに includeRecommendations: false 推奨が出ること', () => {
      const largeData = 'x'.repeat(12 * 1024);
      const largeResponse = { recommendations: [{ data: largeData }] };
      const result = responseSizeWarning.checkResponseSize('quality.evaluate', largeResponse);

      expect(result.recommendation).toContain('includeRecommendations: false');
    });

    it('motion.detect で大きなレスポンスに includeSummary: false 推奨が出ること', () => {
      const largeData = 'x'.repeat(12 * 1024);
      const largeResponse = { patterns: [{ data: largeData }] };
      const result = responseSizeWarning.checkResponseSize('motion.detect', largeResponse);

      expect(result.recommendation).toContain('includeSummary: false');
    });
  });

  describe('server.ts ハンドラーシミュレーション', () => {
    it('ツール呼び出し後にサイズチェックが実行されること', async () => {
      // server.ts の CallToolRequestSchema ハンドラーをシミュレート
      const mockToolResult = { id: '123', name: 'test-layout' };

      // レスポンスサイズチェック（server.ts line 67-68 相当）
      const sizeResult = responseSizeWarning.checkResponseSize('layout.search', mockToolResult);

      expect(sizeResult.toolName).toBe('layout.search');
      expect(sizeResult.sizeBytes).toBeGreaterThan(0);
      expect(sizeResult.sizeFormatted).toMatch(/\d+ B/);
    });

    it('エラーレスポンスでもサイズチェックが機能すること', () => {
      const errorResponse = {
        error: 'PATTERN_NOT_FOUND',
        message: 'パターンが見つかりません',
      };

      const result = responseSizeWarning.checkResponseSize('layout.search', errorResponse);

      expect(result.exceededWarning).toBe(false);
      expect(result.sizeBytes).toBeLessThan(1024);
    });
  });
});
