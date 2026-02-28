// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.batch_ingest MCPツール テスト
 *
 * 複数URLを一括でインジェストするMCPツールのテスト
 *
 * TDD Red Phase: テストを先に作成
 *
 * テストケース:
 * 1. Batch ingest 3 URLs successfully
 * 2. Handle partial failures (1 of 3 fails)
 * 3. Respect concurrency limit
 * 4. Abort on error when on_error: 'abort'
 * 5. Skip failed URLs when on_error: 'skip'
 * 6. Validate URL array size (1-100)
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { ZodError } from 'zod';

// モジュールモック
vi.mock('../../../src/utils/url-validator', () => ({
  validateExternalUrl: vi.fn(),
  BLOCKED_HOSTS: ['localhost', '127.0.0.1', '169.254.169.254'],
  BLOCKED_IP_RANGES: [/^10\./, /^192\.168\./],
}));

vi.mock('../../../src/services/page-ingest-adapter', () => ({
  pageIngestAdapter: {
    ingest: vi.fn(),
  },
}));

vi.mock('../../../src/utils/html-sanitizer', () => ({
  sanitizeHtml: vi.fn(),
}));

// インポート
import {
  layoutBatchIngestHandler,
  layoutBatchIngestToolDefinition,
  type LayoutBatchIngestInput,
  type LayoutBatchIngestOutput,
} from '../../../src/tools/layout/batch-ingest.tool';
import {
  layoutBatchIngestInputSchema,
  layoutBatchIngestOutputSchema,
} from '../../../src/tools/layout/schemas';
import { validateExternalUrl } from '../../../src/utils/url-validator';
import { pageIngestAdapter } from '../../../src/services/page-ingest-adapter';
import { sanitizeHtml } from '../../../src/utils/html-sanitizer';

// テスト用ヘルパー: 成功レスポンスを生成
function createSuccessIngestResult(url: string) {
  return {
    success: true,
    html: `<html><body>Content from ${url}</body></html>`,
    metadata: {
      title: `Page from ${url}`,
      description: 'Test page',
    },
    source: {
      type: 'user_provided' as const,
      usageScope: 'inspiration_only' as const,
    },
    screenshots: [
      {
        data: 'base64data',
        format: 'png' as const,
        viewport: { width: 1920, height: 1080 },
      },
    ],
    ingestedAt: new Date(),
  };
}

// テスト用ヘルパー: 失敗レスポンスを生成
function createFailedIngestResult(url: string, error: string) {
  return {
    success: false,
    error,
    html: '',
    metadata: {},
    source: {
      type: 'user_provided' as const,
      usageScope: 'inspiration_only' as const,
    },
    screenshots: [],
    ingestedAt: new Date(),
  };
}

describe('layout.batch_ingest MCPツール', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルトのモック設定
    (validateExternalUrl as Mock).mockReturnValue({ valid: true, normalizedUrl: '' });
    (sanitizeHtml as Mock).mockImplementation((html: string) => html);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ==========================================
  // スキーマテスト
  // ==========================================
  describe('入力スキーマ (layoutBatchIngestInputSchema)', () => {
    describe('正常系', () => {
      it('URLの配列のみで有効', () => {
        const input = {
          urls: ['https://example.com', 'https://example.org'],
        };
        expect(() => layoutBatchIngestInputSchema.parse(input)).not.toThrow();
      });

      it('全オプションフィールド付きで有効', () => {
        const input: LayoutBatchIngestInput = {
          urls: ['https://example.com', 'https://example.org'],
          options: {
            concurrency: 5,
            on_error: 'skip',
            save_to_db: true,
            auto_analyze: true,
          },
        };
        const result = layoutBatchIngestInputSchema.parse(input);
        expect(result.urls.length).toBe(2);
        expect(result.options?.concurrency).toBe(5);
        expect(result.options?.on_error).toBe('skip');
      });

      it('concurrencyのデフォルト値が5', () => {
        const input = { urls: ['https://example.com'] };
        const result = layoutBatchIngestInputSchema.parse(input);
        expect(result.options?.concurrency ?? 5).toBe(5);
      });

      it('on_errorのデフォルト値がskip', () => {
        const input = { urls: ['https://example.com'] };
        const result = layoutBatchIngestInputSchema.parse(input);
        expect(result.options?.on_error ?? 'skip').toBe('skip');
      });

      it('save_to_dbのデフォルト値がtrue', () => {
        const input = { urls: ['https://example.com'] };
        const result = layoutBatchIngestInputSchema.parse(input);
        expect(result.options?.save_to_db ?? true).toBe(true);
      });

      it('auto_analyzeのデフォルト値がtrue', () => {
        const input = { urls: ['https://example.com'] };
        const result = layoutBatchIngestInputSchema.parse(input);
        expect(result.options?.auto_analyze ?? true).toBe(true);
      });

      it('100件のURLを受け入れる', () => {
        const urls = Array.from({ length: 100 }, (_, i) => `https://example${i}.com`);
        const input = { urls };
        expect(() => layoutBatchIngestInputSchema.parse(input)).not.toThrow();
      });
    });

    describe('異常系', () => {
      it('空の配列の場合エラー', () => {
        const input = { urls: [] };
        expect(() => layoutBatchIngestInputSchema.parse(input)).toThrow(ZodError);
      });

      it('101件以上のURLの場合エラー', () => {
        const urls = Array.from({ length: 101 }, (_, i) => `https://example${i}.com`);
        const input = { urls };
        expect(() => layoutBatchIngestInputSchema.parse(input)).toThrow(ZodError);
      });

      it('無効なURLが含まれる場合エラー', () => {
        const input = { urls: ['https://example.com', 'not-a-url'] };
        expect(() => layoutBatchIngestInputSchema.parse(input)).toThrow(ZodError);
      });

      it('concurrencyが0の場合エラー', () => {
        const input = {
          urls: ['https://example.com'],
          options: { concurrency: 0 },
        };
        expect(() => layoutBatchIngestInputSchema.parse(input)).toThrow(ZodError);
      });

      it('concurrencyが11以上の場合エラー', () => {
        const input = {
          urls: ['https://example.com'],
          options: { concurrency: 11 },
        };
        expect(() => layoutBatchIngestInputSchema.parse(input)).toThrow(ZodError);
      });

      it('on_errorが無効な値の場合エラー', () => {
        const input = {
          urls: ['https://example.com'],
          options: { on_error: 'invalid' },
        };
        expect(() => layoutBatchIngestInputSchema.parse(input)).toThrow(ZodError);
      });
    });
  });

  describe('出力スキーマ (layoutBatchIngestOutputSchema)', () => {
    it('成功レスポンスを検証', () => {
      const output: LayoutBatchIngestOutput = {
        success: true,
        data: {
          job_id: '019af946-a471-77e6-9122-76d627892016',
          total: 3,
          completed: 3,
          failed: 0,
          results: [
            {
              url: 'https://example.com',
              status: 'success',
              page_id: '019af946-a471-77e6-9122-76d627892017',
              patterns_extracted: 5,
            },
            {
              url: 'https://example.org',
              status: 'success',
              page_id: '019af946-a471-77e6-9122-76d627892018',
              patterns_extracted: 3,
            },
            {
              url: 'https://example.net',
              status: 'success',
              page_id: '019af946-a471-77e6-9122-76d627892019',
              patterns_extracted: 4,
            },
          ],
          summary: {
            success_rate: 100,
            total_patterns: 12,
            processing_time_ms: 5000,
          },
        },
      };
      expect(() => layoutBatchIngestOutputSchema.parse(output)).not.toThrow();
    });

    it('部分失敗レスポンスを検証', () => {
      const output: LayoutBatchIngestOutput = {
        success: true,
        data: {
          job_id: '019af946-a471-77e6-9122-76d627892016',
          total: 3,
          completed: 2,
          failed: 1,
          results: [
            {
              url: 'https://example.com',
              status: 'success',
              page_id: '019af946-a471-77e6-9122-76d627892017',
              patterns_extracted: 5,
            },
            {
              url: 'https://invalid-url.com',
              status: 'failed',
              error: 'Network error: Unable to reach the specified URL',
            },
            {
              url: 'https://example.org',
              status: 'success',
              page_id: '019af946-a471-77e6-9122-76d627892018',
              patterns_extracted: 3,
            },
          ],
          summary: {
            success_rate: 66.67,
            total_patterns: 8,
            processing_time_ms: 3000,
          },
        },
      };
      expect(() => layoutBatchIngestOutputSchema.parse(output)).not.toThrow();
    });

    it('エラーレスポンスを検証', () => {
      const output: LayoutBatchIngestOutput = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'URLs array must have 1-100 items',
        },
      };
      expect(() => layoutBatchIngestOutputSchema.parse(output)).not.toThrow();
    });
  });

  // ==========================================
  // ツール定義テスト
  // ==========================================
  describe('ツール定義 (layoutBatchIngestToolDefinition)', () => {
    it('正しいツール名を持つ', () => {
      expect(layoutBatchIngestToolDefinition.name).toBe('layout.batch_ingest');
    });

    it('descriptionが設定されている', () => {
      expect(layoutBatchIngestToolDefinition.description).toBeDefined();
      expect(layoutBatchIngestToolDefinition.description.length).toBeGreaterThan(0);
    });

    it('inputSchemaが設定されている', () => {
      expect(layoutBatchIngestToolDefinition.inputSchema).toBeDefined();
      expect(layoutBatchIngestToolDefinition.inputSchema.type).toBe('object');
      expect(layoutBatchIngestToolDefinition.inputSchema.required).toContain('urls');
    });
  });

  // ==========================================
  // ハンドラーテスト
  // ==========================================
  describe('ハンドラー (layoutBatchIngestHandler)', () => {
    describe('正常系', () => {
      it('3つのURLを正常にインジェスト', async () => {
        // Arrange
        const urls = [
          'https://example.com',
          'https://example.org',
          'https://example.net',
        ];

        urls.forEach((url) => {
          (validateExternalUrl as Mock).mockReturnValueOnce({
            valid: true,
            normalizedUrl: url,
          });
        });

        (pageIngestAdapter.ingest as Mock)
          .mockResolvedValueOnce(createSuccessIngestResult(urls[0]))
          .mockResolvedValueOnce(createSuccessIngestResult(urls[1]))
          .mockResolvedValueOnce(createSuccessIngestResult(urls[2]));

        // Act
        const result = await layoutBatchIngestHandler({
          urls,
          options: { save_to_db: false }, // DBモックを避けるため
        });

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.total).toBe(3);
          expect(result.data.completed).toBe(3);
          expect(result.data.failed).toBe(0);
          expect(result.data.results).toHaveLength(3);
          expect(result.data.summary.success_rate).toBe(100);
        }
      });

      it('部分的な失敗を処理（on_error: skip）', async () => {
        // Arrange
        const urls = [
          'https://example.com',
          'https://failing-site.com',
          'https://example.org',
        ];

        urls.forEach((url) => {
          (validateExternalUrl as Mock).mockReturnValueOnce({
            valid: true,
            normalizedUrl: url,
          });
        });

        (pageIngestAdapter.ingest as Mock)
          .mockResolvedValueOnce(createSuccessIngestResult(urls[0]))
          .mockResolvedValueOnce(createFailedIngestResult(urls[1], 'Network error'))
          .mockResolvedValueOnce(createSuccessIngestResult(urls[2]));

        // Act
        const result = await layoutBatchIngestHandler({
          urls,
          options: { on_error: 'skip', save_to_db: false },
        });

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.total).toBe(3);
          expect(result.data.completed).toBe(2);
          expect(result.data.failed).toBe(1);

          // 成功したURLの結果を確認
          const successResults = result.data.results.filter(r => r.status === 'success');
          expect(successResults).toHaveLength(2);

          // 失敗したURLの結果を確認
          const failedResults = result.data.results.filter(r => r.status === 'failed');
          expect(failedResults).toHaveLength(1);
          expect(failedResults[0]?.error).toBeDefined();
        }
      });

      it('on_error: abort で最初の失敗で中止', async () => {
        // Arrange
        const urls = [
          'https://example.com',
          'https://failing-site.com',
          'https://example.org',
        ];

        urls.forEach((url) => {
          (validateExternalUrl as Mock).mockReturnValueOnce({
            valid: true,
            normalizedUrl: url,
          });
        });

        (pageIngestAdapter.ingest as Mock)
          .mockResolvedValueOnce(createSuccessIngestResult(urls[0]))
          .mockResolvedValueOnce(createFailedIngestResult(urls[1], 'Network error'));
        // 3番目のURLは呼ばれないはず

        // Act
        const result = await layoutBatchIngestHandler({
          urls,
          options: { on_error: 'abort', save_to_db: false },
        });

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('BATCH_ABORTED');
          expect(result.error.message).toContain('failing-site.com');
        }
      });

      it('並行処理の制限を尊重', async () => {
        // Arrange
        const urls = Array.from({ length: 10 }, (_, i) => `https://example${i}.com`);
        const concurrency = 3;
        const callOrder: number[] = [];
        let activeCount = 0;
        let maxActiveCount = 0;

        urls.forEach((url) => {
          (validateExternalUrl as Mock).mockReturnValueOnce({
            valid: true,
            normalizedUrl: url,
          });
        });

        (pageIngestAdapter.ingest as Mock).mockImplementation(async (options) => {
          activeCount++;
          maxActiveCount = Math.max(maxActiveCount, activeCount);
          callOrder.push(urls.indexOf(options.url));

          // シミュレート処理時間
          await new Promise((resolve) => setTimeout(resolve, 10));

          activeCount--;
          return createSuccessIngestResult(options.url);
        });

        // Act
        const result = await layoutBatchIngestHandler({
          urls,
          options: { concurrency, save_to_db: false },
        });

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.total).toBe(10);
          expect(result.data.completed).toBe(10);
        }
        // 並行処理数が制限を超えないことを確認
        expect(maxActiveCount).toBeLessThanOrEqual(concurrency);
      });

      it('job_idがUUIDv7形式で生成される', async () => {
        // Arrange
        (validateExternalUrl as Mock).mockReturnValue({
          valid: true,
          normalizedUrl: 'https://example.com',
        });
        (pageIngestAdapter.ingest as Mock).mockResolvedValue(
          createSuccessIngestResult('https://example.com')
        );

        // Act
        const result = await layoutBatchIngestHandler({
          urls: ['https://example.com'],
          options: { save_to_db: false },
        });

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          // UUIDv7形式の検証: 8-4-4-4-12 で、バージョンが7
          const uuidV7Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          expect(result.data.job_id).toMatch(uuidV7Regex);
        }
      });

      it('処理時間がsummaryに含まれる', async () => {
        // Arrange
        (validateExternalUrl as Mock).mockReturnValue({
          valid: true,
          normalizedUrl: 'https://example.com',
        });
        (pageIngestAdapter.ingest as Mock).mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return createSuccessIngestResult('https://example.com');
        });

        // Act
        const result = await layoutBatchIngestHandler({
          urls: ['https://example.com'],
          options: { save_to_db: false },
        });

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.summary.processing_time_ms).toBeGreaterThan(0);
        }
      });
    });

    describe('異常系', () => {
      it('空のURL配列でバリデーションエラー', async () => {
        // Act
        const result = await layoutBatchIngestHandler({
          urls: [],
        });

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('VALIDATION_ERROR');
        }
      });

      it('101件以上のURLでバリデーションエラー', async () => {
        // Arrange
        const urls = Array.from({ length: 101 }, (_, i) => `https://example${i}.com`);

        // Act
        const result = await layoutBatchIngestHandler({ urls });

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('VALIDATION_ERROR');
        }
      });

      it('SSRFブロックされたURLを含む場合', async () => {
        // Arrange
        const urls = ['https://example.com', 'http://169.254.169.254/metadata'];

        (validateExternalUrl as Mock)
          .mockReturnValueOnce({ valid: true, normalizedUrl: urls[0] })
          .mockReturnValueOnce({ valid: false, error: 'SSRF blocked' });

        (pageIngestAdapter.ingest as Mock).mockResolvedValue(
          createSuccessIngestResult('https://example.com')
        );

        // Act
        const result = await layoutBatchIngestHandler({
          urls,
          options: { on_error: 'skip', save_to_db: false },
        });

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.completed).toBe(1);
          expect(result.data.failed).toBe(1);
          const failedResult = result.data.results.find(r => r.status === 'failed');
          expect(failedResult?.error).toContain('SSRF');
        }
      });
    });
  });
});
