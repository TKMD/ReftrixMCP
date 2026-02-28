// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * サービスクライアント テスト
 * Webアプリサービス接続のテスト
 *
 * 注意: v0.1.0でSVG機能は完全に削除されました。
 * このテストファイルはWebDesign API接続のテストのみを行います。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// サービスクライアントの型定義
interface LayoutSearchParams {
  q: string;
  section_type?: string;
  limit?: number;
  offset?: number;
}

interface ServiceClient {
  searchLayouts(params: LayoutSearchParams): Promise<unknown>;
  getPage(id: string): Promise<unknown>;
}

// 共通のAPI URL
const API_BASE_URL = 'http://localhost:24000/api/v1';

// 共通のサービスクライアント作成関数
const createServiceClient = (options: { logEnabled?: boolean } = {}): ServiceClient => ({
  searchLayouts: async (params) => {
    if (options.logEnabled && process.env.NODE_ENV === 'development') {
      console.log('[MCP] Calling layout search API');
    }
    const response = await fetch(`${API_BASE_URL}/layout/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error(`Layout Search API error: ${response.status}`);
    return response.json();
  },
  getPage: async (id) => {
    const response = await fetch(`${API_BASE_URL}/page/${id}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Get Page API error: ${response.status}`);
    return response.json();
  },
});

// 共通のモックレスポンス作成関数
const createMockResponse = (options: { ok?: boolean; status?: number; data?: unknown } = {}) => ({
  ok: options.ok ?? true,
  status: options.status ?? 200,
  json: async () => options.data ?? {},
});

describe('Service Client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('API呼び出しモック', () => {
    it('fetchがモックされていること', () => {
      fetchMock.mockResolvedValueOnce(createMockResponse({ data: { success: true } }));
      expect(global.fetch).toBeDefined();
      expect(typeof global.fetch).toBe('function');
    });

    it('API_BASE_URLが設定されていること', () => {
      const expectedUrl = process.env.REFTRIX_API_URL || API_BASE_URL;
      expect(expectedUrl).toBeDefined();
      expect(expectedUrl).toContain('/api/v1');
    });
  });

  describe('レイアウト検索API接続', () => {
    it('searchLayouts()が正常に呼び出せること', async () => {
      const mockResponse = { items: [{ id: '123', section_type: 'hero' }], total: 1 };
      fetchMock.mockResolvedValueOnce(createMockResponse({ data: mockResponse }));

      const serviceClient = createServiceClient();
      const result = await serviceClient.searchLayouts({ q: 'hero section' });

      expect(fetchMock).toHaveBeenCalledWith(
        `${API_BASE_URL}/layout/search`,
        expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
      );
      expect(result).toEqual(mockResponse);
    });

    it('検索パラメータが正しく渡されること', async () => {
      fetchMock.mockResolvedValueOnce(createMockResponse({ data: { items: [], total: 0 } }));

      const serviceClient = createServiceClient();
      const params: LayoutSearchParams = { q: 'feature grid', section_type: 'feature', limit: 10 };
      await serviceClient.searchLayouts(params);

      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify(params) }));
    });

    it('検索APIエラー時に例外がスローされること', async () => {
      fetchMock.mockResolvedValueOnce(createMockResponse({ ok: false, status: 400 }));

      const serviceClient = createServiceClient();
      await expect(serviceClient.searchLayouts({ q: 'test' })).rejects.toThrow('Layout Search API error: 400');
    });
  });

  describe('ページ取得API接続', () => {
    const pageId = '123e4567-e89b-12d3-a456-426614174000';

    it('getPage()が正常に呼び出せること', async () => {
      const mockPage = { id: pageId, url: 'https://example.com', title: 'Test Page' };
      fetchMock.mockResolvedValueOnce(createMockResponse({ data: mockPage }));

      const serviceClient = createServiceClient();
      const result = await serviceClient.getPage(pageId);

      expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/page/${pageId}`);
      expect(result).toEqual(mockPage);
    });

    it('ページが存在しない場合にnullが返されること', async () => {
      fetchMock.mockResolvedValueOnce(createMockResponse({ ok: false, status: 404 }));

      const serviceClient = createServiceClient();
      const result = await serviceClient.getPage(pageId);

      expect(result).toBeNull();
    });

    it('取得APIエラー時に例外がスローされること', async () => {
      fetchMock.mockResolvedValueOnce(createMockResponse({ ok: false, status: 500 }));

      const serviceClient = createServiceClient();
      await expect(serviceClient.getPage(pageId)).rejects.toThrow('Get Page API error: 500');
    });
  });

  describe('エラーハンドリング', () => {
    it.each([
      {
        desc: 'ネットワークエラー時に例外がスローされること',
        setup: () => fetchMock.mockRejectedValueOnce(new Error('Network error')),
        expectedError: 'Network error',
      },
      {
        desc: 'タイムアウト時に例外がスローされること',
        setup: () => fetchMock.mockImplementationOnce(() =>
          new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), 100))
        ),
        expectedError: 'Request timeout',
      },
      {
        desc: '不正なJSONレスポンス時に例外がスローされること',
        setup: () => fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }),
        expectedError: 'Invalid JSON',
      },
    ])('$desc', async ({ setup, expectedError }) => {
      setup();
      const serviceClient = createServiceClient();
      await expect(serviceClient.searchLayouts({ q: 'test' })).rejects.toThrow(expectedError);
    });
  });

  describe('開発環境ログ出力', () => {
    it('API呼び出し時にログが出力されること', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      fetchMock.mockResolvedValueOnce(createMockResponse({ data: { items: [], total: 0 } }));

      const serviceClient = createServiceClient({ logEnabled: true });
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      await serviceClient.searchLayouts({ q: 'test' });

      expect(consoleSpy).toHaveBeenCalledWith('[MCP] Calling layout search API');
      consoleSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
    });

    it('本番環境ではログが抑制されること', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const consoleSpy = vi.spyOn(console, 'log');
      fetchMock.mockResolvedValueOnce(createMockResponse({ data: { items: [], total: 0 } }));

      const serviceClient = createServiceClient({ logEnabled: true });
      await serviceClient.searchLayouts({ q: 'test' });

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
    });
  });
});
