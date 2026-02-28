// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * レスポンスサイズ警告ミドルウェアテスト
 * TDD Red フェーズ: MCP レスポンスサイズが閾値を超えた場合に警告を出すテスト
 *
 * @module response-size-warning.test
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ResponseSizeWarning,
  DEFAULT_WARNING_THRESHOLD_KB,
  DEFAULT_CRITICAL_THRESHOLD_KB,
  calculateResponseSize,
  formatSize,
  type ResponseSizeResult,
} from '../../src/middleware/response-size-warning';
import { Logger } from '../../src/utils/logger';

// Loggerのモック
vi.mock('../../src/utils/logger', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  createLogger: vi.fn().mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

describe('ResponseSizeWarning ミドルウェア', () => {
  let middleware: ResponseSizeWarning;
  let mockLogger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    middleware = new ResponseSizeWarning(mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('定数', () => {
    it('デフォルト警告閾値が10KBであること', () => {
      expect(DEFAULT_WARNING_THRESHOLD_KB).toBe(10);
    });

    it('デフォルトクリティカル閾値が50KBであること', () => {
      expect(DEFAULT_CRITICAL_THRESHOLD_KB).toBe(50);
    });
  });

  describe('calculateResponseSize ユーティリティ', () => {
    it('空オブジェクトのサイズを正しく計算すること', () => {
      const size = calculateResponseSize({});
      // {} = 2 bytes
      expect(size).toBe(2);
    });

    it('文字列を含むオブジェクトのサイズを正しく計算すること', () => {
      const obj = { message: 'hello' };
      const size = calculateResponseSize(obj);
      const expected = JSON.stringify(obj).length;
      expect(size).toBe(expected);
    });

    it('ネストされたオブジェクトのサイズを正しく計算すること', () => {
      const obj = {
        level1: {
          level2: {
            data: 'nested',
          },
        },
      };
      const size = calculateResponseSize(obj);
      const expected = JSON.stringify(obj).length;
      expect(size).toBe(expected);
    });

    it('配列を含むオブジェクトのサイズを正しく計算すること', () => {
      const obj = { items: [1, 2, 3, 4, 5] };
      const size = calculateResponseSize(obj);
      const expected = JSON.stringify(obj).length;
      expect(size).toBe(expected);
    });

    it('循環参照がある場合はエラーをスローすること', () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      expect(() => calculateResponseSize(obj)).toThrow();
    });
  });

  describe('formatSize ユーティリティ', () => {
    it('バイト単位を正しくフォーマットすること', () => {
      expect(formatSize(500)).toBe('500 B');
    });

    it('KB単位を正しくフォーマットすること', () => {
      expect(formatSize(1024)).toBe('1.00 KB');
      expect(formatSize(2048)).toBe('2.00 KB');
      expect(formatSize(1536)).toBe('1.50 KB');
    });

    it('MB単位を正しくフォーマットすること', () => {
      expect(formatSize(1048576)).toBe('1.00 MB');
      expect(formatSize(2097152)).toBe('2.00 MB');
    });
  });

  describe('checkResponseSize メソッド', () => {
    it('閾値以下のレスポンスでは警告を出さないこと', () => {
      const smallResponse = { data: 'small' };
      const result = middleware.checkResponseSize('test.tool', smallResponse);

      expect(result.exceededWarning).toBe(false);
      expect(result.exceededCritical).toBe(false);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('警告閾値を超えた場合に警告ログを出力すること', () => {
      // 10KB以上のレスポンスを生成
      const largeData = 'x'.repeat(11 * 1024);
      const largeResponse = { data: largeData };
      const result = middleware.checkResponseSize('layout.search', largeResponse);

      expect(result.exceededWarning).toBe(true);
      expect(result.exceededCritical).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('layout.search'),
        expect.objectContaining({
          sizeBytes: expect.any(Number),
          sizeFormatted: expect.any(String),
          thresholdKB: DEFAULT_WARNING_THRESHOLD_KB,
        })
      );
    });

    it('クリティカル閾値を超えた場合にエラーログを出力すること', () => {
      // 50KB以上のレスポンスを生成
      const veryLargeData = 'x'.repeat(51 * 1024);
      const veryLargeResponse = { data: veryLargeData };
      const result = middleware.checkResponseSize('motion.detect', veryLargeResponse);

      expect(result.exceededWarning).toBe(true);
      expect(result.exceededCritical).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('motion.detect'),
        expect.objectContaining({
          sizeBytes: expect.any(Number),
          sizeFormatted: expect.any(String),
          thresholdKB: DEFAULT_CRITICAL_THRESHOLD_KB,
        })
      );
    });

    it('カスタム閾値を設定できること', () => {
      const customMiddleware = new ResponseSizeWarning(mockLogger, {
        warningThresholdKB: 5,
        criticalThresholdKB: 20,
      });

      // 5KB以上、20KB未満のレスポンス
      const mediumData = 'x'.repeat(6 * 1024);
      const mediumResponse = { data: mediumData };
      const result = customMiddleware.checkResponseSize('test.tool', mediumResponse);

      expect(result.exceededWarning).toBe(true);
      expect(result.exceededCritical).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('ツール名がレスポンスサイズとともにログに含まれること', () => {
      const largeData = 'x'.repeat(15 * 1024);
      const largeResponse = { data: largeData };
      middleware.checkResponseSize('layout.ingest', largeResponse);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('layout.ingest'),
        expect.any(Object)
      );
    });

    it('最適化推奨メッセージがログに含まれること', () => {
      const largeData = 'x'.repeat(15 * 1024);
      const largeResponse = { data: largeData };
      const result = middleware.checkResponseSize('layout.search', largeResponse);

      expect(result.recommendation).toBeDefined();
      // WebDesign用ツールの最適化推奨メッセージにはincludeHtmlが含まれる
      expect(result.recommendation).toContain('includeHtml');
    });
  });

  describe('getOptimizationRecommendation メソッド', () => {
    it('layout.search には includeHtml: false を推奨すること', () => {
      const recommendation = middleware.getOptimizationRecommendation('layout.search');
      expect(recommendation).toContain('includeHtml: false');
    });

    it('layout.ingest には include_html: false, include_screenshot: false を推奨すること', () => {
      const recommendation = middleware.getOptimizationRecommendation('layout.ingest');
      expect(recommendation).toContain('include_html: false');
      expect(recommendation).toContain('include_screenshot: false');
    });

    it('quality.evaluate には includeRecommendations: false を推奨すること', () => {
      const recommendation = middleware.getOptimizationRecommendation('quality.evaluate');
      expect(recommendation).toContain('includeRecommendations: false');
    });

    it('motion.detect には includeSummary: false を推奨すること', () => {
      const recommendation = middleware.getOptimizationRecommendation('motion.detect');
      expect(recommendation).toContain('includeSummary: false');
    });

    it('未対応ツールには汎用的な推奨を返すこと', () => {
      const recommendation = middleware.getOptimizationRecommendation('unknown.tool');
      expect(recommendation).toContain('limit');
    });
  });

  describe('ResponseSizeResult 型', () => {
    it('結果オブジェクトが正しい構造を持つこと', () => {
      const smallResponse = { data: 'test' };
      const result: ResponseSizeResult = middleware.checkResponseSize('test.tool', smallResponse);

      expect(result).toHaveProperty('sizeBytes');
      expect(result).toHaveProperty('sizeFormatted');
      expect(result).toHaveProperty('exceededWarning');
      expect(result).toHaveProperty('exceededCritical');
      expect(result).toHaveProperty('toolName');
      expect(typeof result.sizeBytes).toBe('number');
      expect(typeof result.sizeFormatted).toBe('string');
      expect(typeof result.exceededWarning).toBe('boolean');
      expect(typeof result.exceededCritical).toBe('boolean');
      expect(typeof result.toolName).toBe('string');
    });
  });

  describe('統合テスト', () => {
    it('開発環境でのみ警告を出力すること', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const largeData = 'x'.repeat(15 * 1024);
      const largeResponse = { data: largeData };
      middleware.checkResponseSize('layout.search', largeResponse);

      expect(mockLogger.warn).toHaveBeenCalled();

      process.env.NODE_ENV = originalEnv;
    });

    it('連続した大きなレスポンスで各々警告を出力すること', () => {
      const largeData = 'x'.repeat(12 * 1024);
      const largeResponse = { data: largeData };

      middleware.checkResponseSize('layout.search', largeResponse);
      middleware.checkResponseSize('layout.ingest', largeResponse);
      middleware.checkResponseSize('motion.detect', largeResponse);

      expect(mockLogger.warn).toHaveBeenCalledTimes(3);
    });
  });
});
