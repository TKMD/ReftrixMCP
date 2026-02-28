// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.ingest DB保存機能 ユニットテスト
 *
 * save_to_db: true オプションによるWebPageテーブル保存機能のテスト
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoistedでモック関数を先に定義（ホイスティング対策）
const { mockValidateExternalUrl, mockSanitizeHtml, mockIngest, mockUpsert } = vi.hoisted(() => ({
  mockValidateExternalUrl: vi.fn(),
  mockSanitizeHtml: vi.fn(),
  mockIngest: vi.fn(),
  mockUpsert: vi.fn(),
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

// html-sanitizerモック
vi.mock('../../../src/utils/html-sanitizer', () => ({
  sanitizeHtml: mockSanitizeHtml,
}));

// page-ingest-adapterモック
vi.mock('../../../src/services/page-ingest-adapter', () => ({
  pageIngestAdapter: {
    ingest: mockIngest,
  },
}));

import { layoutIngestHandler } from '../../../src/tools/layout/ingest.tool';
import { LAYOUT_MCP_ERROR_CODES } from '../../../src/tools/layout/schemas';

describe('layout.ingest DB保存機能', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルトモック設定
    mockValidateExternalUrl.mockReturnValue({
      valid: true,
      normalizedUrl: 'https://example.com/',
    });

    mockSanitizeHtml.mockImplementation((html: string) => html);

    mockIngest.mockResolvedValue({
      success: true,
      html: '<html><head><title>Test Page</title></head><body>Content</body></html>',
      screenshots: [],
      metadata: {
        title: 'Test Page',
        description: 'Test description',
        favicon: 'https://example.com/favicon.ico',
        ogImage: 'https://example.com/og.png',
      },
      source: {
        type: 'user_provided',
        usageScope: 'inspiration_only',
      },
      ingestedAt: new Date('2025-01-01T00:00:00Z'),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('save_to_db オプション', () => {
    it('save_to_db: false (デフォルト) でDBに保存しない', async () => {
      const result = await layoutIngestHandler({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(mockUpsert).not.toHaveBeenCalled();
      if (result.success) {
        expect(result.data.savedToDb).toBeUndefined();
      }
    });

    it('save_to_db: true でDBに保存する', async () => {
      const mockSavedPage = {
        id: '01234567-89ab-cdef-0123-456789abcdef',
      };

      mockUpsert.mockResolvedValue(mockSavedPage as never);

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockUpsert).toHaveBeenCalledTimes(1);

      // upsertの呼び出し引数を確認
      // normalizeUrlForStorage()が末尾スラッシュを除去するため、trailing slashなし
      const upsertCall = mockUpsert.mock.calls[0][0];
      expect(upsertCall.where).toEqual({ url: 'https://example.com' });
      expect(upsertCall.create).toMatchObject({
        url: 'https://example.com',
        title: 'Test Page',
        description: 'Test description',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        analysisStatus: 'pending',
      });
      expect(upsertCall.create.htmlContent).toBeDefined();
      expect(upsertCall.create.htmlHash).toBeDefined();

      if (result.success) {
        expect(result.data.id).toBe(mockSavedPage.id);
        expect(result.data.savedToDb).toBe(true);
      }
    });

    it('DB保存失敗時にエラーを返す', async () => {
      mockUpsert.mockRejectedValue(new Error('Database connection failed'));

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(LAYOUT_MCP_ERROR_CODES.DB_SAVE_FAILED);
        expect(result.error.message).toContain('Database connection failed');
      }
    });

    it('HTMLがない場合はDB保存をスキップする', async () => {
      // HTMLなしのレスポンスを返すモック
      mockIngest.mockResolvedValueOnce({
        success: true,
        html: '', // 空のHTML
        screenshots: [],
        metadata: {
          title: 'Test Page',
        },
        source: {
          type: 'user_provided',
          usageScope: 'inspiration_only',
        },
        ingestedAt: new Date(),
      });

      // sanitizeHtmlが空文字を返すようにモック
      mockSanitizeHtml.mockReturnValueOnce('');

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
        },
      });

      expect(result.success).toBe(true);
      // HTMLが空なのでDB保存は呼ばれない
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('メタデータが正しく保存される', async () => {
      const mockSavedPage = {
        id: '01234567-89ab-cdef-0123-456789abcdef',
      };

      mockUpsert.mockResolvedValue(mockSavedPage as never);

      await layoutIngestHandler({
        url: 'https://example.com',
        source_type: 'award_gallery',
        usage_scope: 'owned_asset',
        options: {
          save_to_db: true,
        },
      });

      const upsertCall = mockUpsert.mock.calls[0][0];
      expect(upsertCall.create.metadata).toEqual({
        favicon: 'https://example.com/favicon.ico',
        ogImage: 'https://example.com/og.png',
      });
    });

    it('HTMLハッシュがSHA-256形式である', async () => {
      const mockSavedPage = {
        id: '01234567-89ab-cdef-0123-456789abcdef',
      };

      mockUpsert.mockResolvedValue(mockSavedPage as never);

      await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
        },
      });

      const upsertCall = mockUpsert.mock.calls[0][0];
      // SHA-256ハッシュは64文字の16進数文字列
      expect(upsertCall.create.htmlHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('レスポンス構造', () => {
    it('save_to_db: true 時にDB IDが返される', async () => {
      const expectedId = 'db-generated-uuid-here';
      mockUpsert.mockResolvedValue({
        id: expectedId,
      } as never);

      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: true,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(expectedId);
        expect(result.data.savedToDb).toBe(true);
      }
    });

    it('save_to_db: false 時にUUIDv7形式のIDが返される', async () => {
      const result = await layoutIngestHandler({
        url: 'https://example.com',
        options: {
          save_to_db: false,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // UUIDv7形式: 8-4-7xxx-xxxx-12
        expect(result.data.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
        expect(result.data.savedToDb).toBeUndefined();
      }
    });
  });
});
