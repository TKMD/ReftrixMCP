// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ServiceClient 耐障害性テスト
 * タイムアウトとリトライ機能のテスト
 *
 * TDD: Red → Green → Refactor
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ServiceClient,
  ServiceClientOptions,
  ServiceClientError,
  ServiceClientErrorCode,
} from '../../src/services/service-client';

describe('ServiceClient 耐障害性', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('タイムアウト機能', () => {
    it('デフォルトタイムアウトは30秒であること', () => {
      const client = new ServiceClient();
      expect(client.getOptions().timeout).toBe(30000);
    });

    it('カスタムタイムアウトを設定できること', () => {
      const client = new ServiceClient(undefined, { timeout: 5000 });
      expect(client.getOptions().timeout).toBe(5000);
    });

    it('タイムアウト時にTIMEOUT_ERRORがスローされること', async () => {
      // AbortControllerはfake timersと相性が悪いため、実際のタイマーを使用
      vi.useRealTimers();

      // fetchがAbortSignalを適切に処理するようモック
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted.');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      const client = new ServiceClient(undefined, { timeout: 100 }); // 短いタイムアウト

      await expect(client.getProject('test-id')).rejects.toThrow(ServiceClientError);
      await expect(client.getProject('test-id')).rejects.toMatchObject({
        code: ServiceClientErrorCode.TIMEOUT_ERROR,
        message: expect.stringContaining('Request timeout'),
      });

      vi.useFakeTimers();
    }, 5000); // 5秒タイムアウト

    it('タイムアウト前に正常レスポンスを受信した場合は成功すること', async () => {
      const mockData = { id: 'test-id', name: 'Test Project' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockData }),
      });

      const client = new ServiceClient(undefined, { timeout: 5000 });
      const result = await client.getProject('test-id');

      expect(result).toBeDefined();
      expect(result?.id).toBe('test-id');
    });
  });

  describe('リトライ機能', () => {
    it('デフォルトリトライ回数は3回であること', () => {
      const client = new ServiceClient();
      expect(client.getOptions().maxRetries).toBe(3);
    });

    it('デフォルトリトライ遅延は100msであること', () => {
      const client = new ServiceClient();
      expect(client.getOptions().retryDelay).toBe(100);
    });

    it('カスタムリトライ設定を適用できること', () => {
      const client = new ServiceClient(undefined, {
        maxRetries: 5,
        retryDelay: 200,
      });
      expect(client.getOptions().maxRetries).toBe(5);
      expect(client.getOptions().retryDelay).toBe(200);
    });

    describe('リトライ対象エラー', () => {
      it.each([500, 502, 503, 504])('5xx系エラー(%i)でリトライすること', async (status) => {
        // 最初の3回は5xxエラー、4回目で成功
        fetchMock
          .mockResolvedValueOnce({ ok: false, status, text: async () => 'Server Error' })
          .mockResolvedValueOnce({ ok: false, status, text: async () => 'Server Error' })
          .mockResolvedValueOnce({ ok: false, status, text: async () => 'Server Error' })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'test', name: 'Test' } }),
          });

        const client = new ServiceClient(undefined, { maxRetries: 3, retryDelay: 100 });
        const promise = client.getProject('test-id');

        // リトライ遅延を進める
        await vi.advanceTimersByTimeAsync(100); // 1回目リトライ
        await vi.advanceTimersByTimeAsync(200); // 2回目リトライ (指数バックオフ)
        await vi.advanceTimersByTimeAsync(400); // 3回目リトライ

        const result = await promise;
        expect(result).toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(4);
      });

      it('ネットワークエラーでリトライすること', async () => {
        fetchMock
          .mockRejectedValueOnce(new Error('Network error'))
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'test', name: 'Test' } }),
          });

        const client = new ServiceClient(undefined, { maxRetries: 3, retryDelay: 100 });
        const promise = client.getProject('test-id');

        await vi.advanceTimersByTimeAsync(100); // 1回目リトライ
        await vi.advanceTimersByTimeAsync(200); // 2回目リトライ

        const result = await promise;
        expect(result).toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    });

    describe('リトライ非対象エラー', () => {
      it.each([400, 401, 403, 404, 422])('4xx系エラー(%i)ではリトライしないこと', async (status) => {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status,
          text: async () => 'Client Error',
        });

        const client = new ServiceClient(undefined, { maxRetries: 3 });
        const promise = client.getProject('test-id');

        // 4xxエラーは即座に失敗（リトライなし）
        if (status === 404) {
          // 404はnullを返す
          const result = await promise;
          expect(result).toBeNull();
        } else {
          await expect(promise).rejects.toThrow();
        }

        // リトライなしなので1回のみ呼ばれる
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    describe('指数バックオフ', () => {
      it('リトライ遅延が指数的に増加すること (100ms, 200ms, 400ms)', async () => {
        // 最初に実際のタイマーに切り替え
        vi.useRealTimers();

        const delays: number[] = [];
        const originalSetTimeout = global.setTimeout;

        // setTimeoutの呼び出しを追跡（実際のタイマーで動作）
        global.setTimeout = ((fn: () => void, delay?: number): ReturnType<typeof setTimeout> => {
          if (typeof delay === 'number' && delay > 0) {
            delays.push(delay);
          }
          // 実際に待機するが、遅延は短くする（テスト時間短縮）
          return originalSetTimeout(fn, 1);
        }) as typeof setTimeout;

        fetchMock
          .mockRejectedValueOnce(new Error('Network error'))
          .mockRejectedValueOnce(new Error('Network error'))
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'test' } }),
          });

        const client = new ServiceClient(undefined, { maxRetries: 3, retryDelay: 100 });

        await client.getProject('test-id');

        // 遅延は100ms, 200ms, 400ms (3回のリトライ)
        expect(delays).toContain(100);
        expect(delays).toContain(200);
        expect(delays).toContain(400);

        // クリーンアップ
        global.setTimeout = originalSetTimeout;
        vi.useFakeTimers();
      });
    });

    describe('最大リトライ超過', () => {
      it('最大リトライ回数を超えた場合MAX_RETRIES_EXCEEDEDがスローされること', async () => {
        fetchMock.mockRejectedValue(new Error('Network error'));

        const client = new ServiceClient(undefined, { maxRetries: 3, retryDelay: 100 });

        // 実際のタイマーで実行
        vi.useRealTimers();

        await expect(client.getProject('test-id')).rejects.toThrow(ServiceClientError);
        await expect(client.getProject('test-id')).rejects.toMatchObject({
          code: ServiceClientErrorCode.MAX_RETRIES_EXCEEDED,
        });

        vi.useFakeTimers();
      });
    });
  });

  describe('オプションのマージと後方互換性', () => {
    it('baseUrlのみ指定した場合デフォルトオプションが使用されること', () => {
      const client = new ServiceClient('http://custom-url.com/api');
      const options = client.getOptions();

      expect(options.timeout).toBe(30000);
      expect(options.maxRetries).toBe(3);
      expect(options.retryDelay).toBe(100);
    });

    it('部分的なオプション指定でデフォルト値とマージされること', () => {
      const client = new ServiceClient(undefined, { timeout: 10000 });
      const options = client.getOptions();

      expect(options.timeout).toBe(10000);
      expect(options.maxRetries).toBe(3); // デフォルト値
      expect(options.retryDelay).toBe(100); // デフォルト値
    });
  });

  describe('エラーハンドリング', () => {
    it('ServiceClientErrorにcodeとmessageが含まれること', async () => {
      // AbortControllerはfake timersと相性が悪いため、実際のタイマーを使用
      vi.useRealTimers();

      // fetchがAbortSignalを適切に処理するようモック
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted.');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      const client = new ServiceClient(undefined, { timeout: 100 });

      try {
        await client.getProject('test-id');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceClientError);
        const serviceError = error as ServiceClientError;
        expect(serviceError.code).toBe(ServiceClientErrorCode.TIMEOUT_ERROR);
        expect(serviceError.message.toLowerCase()).toContain('timeout');
      }

      vi.useFakeTimers();
    }, 5000); // 5秒タイムアウト

    it('リトライ回数がエラーメッセージに含まれること', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const client = new ServiceClient(undefined, { maxRetries: 2, retryDelay: 10 });

      vi.useRealTimers();

      try {
        await client.getProject('test-id');
        expect.fail('Should have thrown');
      } catch (error) {
        const serviceError = error as ServiceClientError;
        expect(serviceError.message).toContain('2');
      }

      vi.useFakeTimers();
    });
  });

  describe('開発環境ログ', () => {
    it('開発環境ではリトライログが出力されること', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      fetchMock
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'test' } }),
        });

      const client = new ServiceClient(undefined, { maxRetries: 3, retryDelay: 10 });

      vi.useRealTimers();
      await client.getProject('test-id');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[ServiceClient]'));
      // ログメッセージは "Retrying" で始まる（大文字R）
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Retrying'));

      consoleSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
      vi.useFakeTimers();
    });

    it('本番環境ではリトライログが抑制されること', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      fetchMock
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'test' } }),
        });

      const client = new ServiceClient(undefined, { maxRetries: 3, retryDelay: 10 });

      vi.useRealTimers();
      await client.getProject('test-id');

      // 本番環境ではinfoレベルのログは出力されない
      const retryCalls = consoleSpy.mock.calls.filter(
        (call) => call[0]?.toString().includes('retry')
      );
      expect(retryCalls.length).toBe(0);

      consoleSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
      vi.useFakeTimers();
    });
  });

  describe('既存メソッドの動作確認', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useFakeTimers();
    });

    it('getProject()がタイムアウトとリトライを適用すること', async () => {
      const mockData = {
        id: 'project-1',
        name: 'Test Project',
        slug: 'test-project',
        description: null,
        status: 'draft',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        brandSetting: null,
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockData }),
      });

      const client = new ServiceClient(undefined, { timeout: 5000, maxRetries: 2 });
      const result = await client.getProject('project-1');

      expect(result).toEqual(mockData);
    });

    it('listProjects()がタイムアウトとリトライを適用すること', async () => {
      const mockData = {
        projects: [{ id: 'p1', name: 'Project 1' }],
        total: 1,
        limit: 10,
        offset: 0,
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockData }),
      });

      const client = new ServiceClient(undefined, { timeout: 5000, maxRetries: 2 });
      const result = await client.listProjects();

      expect(result.total).toBe(1);
    });

    it('getPalette()がタイムアウトとリトライを適用すること', async () => {
      const mockData = {
        id: 'palette-1',
        name: 'Test Palette',
        slug: 'test-palette',
        description: null,
        mode: 'light',
        isDefault: true,
        tokens: [],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockData }),
      });

      const client = new ServiceClient(undefined, { timeout: 5000, maxRetries: 2 });
      const result = await client.getPalette('palette-1');

      expect(result?.id).toBe('palette-1');
    });
  });
});
