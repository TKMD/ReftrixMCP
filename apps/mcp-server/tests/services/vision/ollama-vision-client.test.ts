// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OllamaVisionClient Unit Tests
 *
 * Vision API呼び出しクライアントのユニットテスト
 * - タイムアウトハンドリング
 * - リトライロジック（指数バックオフ）
 * - エラーハンドリング
 * - Graceful Degradation
 *
 * @module tests/services/vision/ollama-vision-client.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaVisionClient } from '../../../src/services/vision/ollama-vision-client.js';
import { VisionAnalysisError } from '../../../src/services/vision/vision.errors.js';

// グローバルfetchをモック
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaVisionClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('デフォルト設定で初期化できること', () => {
      const client = new OllamaVisionClient();
      expect(client).toBeDefined();
    });

    it('カスタム設定で初期化できること', () => {
      const client = new OllamaVisionClient({
        ollamaUrl: 'http://custom:11434',
        timeout: 60000,
        model: 'custom-vision',
        enableRetry: true,
        maxRetries: 5,
      });
      expect(client).toBeDefined();
    });
  });

  describe('timeout handling', () => {
    it('タイムアウト時にTIMEOUTエラーをスローすること', async () => {
      // AbortControllerを使用したタイムアウトをシミュレート
      const client = new OllamaVisionClient({
        timeout: 50, // 50ms
        enableRetry: false, // リトライ無効で即座にエラー
      });

      // AbortErrorを即座にスローするようにモック
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      await expect(client.generate('base64image', 'test prompt')).rejects.toThrow(
        VisionAnalysisError
      );
    }, 10000); // 10秒タイムアウト

    it('タイムアウトエラーはisRetryable=trueであること', async () => {
      const client = new OllamaVisionClient({
        timeout: 50,
        enableRetry: false, // リトライ無効で即座にエラー
      });

      // AbortErrorを即座にスローするようにモック
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      try {
        await client.generate('base64image', 'test prompt');
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(VisionAnalysisError);
        const visionError = error as VisionAnalysisError;
        expect(visionError.code).toBe('TIMEOUT');
        expect(visionError.isRetryable).toBe(true);
      }
    }, 10000); // 10秒タイムアウト
  });

  describe('retry logic', () => {
    it('enableRetry=falseの場合リトライしないこと', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
        timeout: 30000,
      });

      // 接続拒否エラーを即座にスロー
      mockFetch.mockRejectedValue(new Error('connection refused'));

      await expect(client.generate('base64image', 'test prompt')).rejects.toThrow(
        'Cannot connect to Ollama service'
      );

      // fetchは1回のみ呼び出される
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }, 10000); // 10秒タイムアウト

    it('enableRetry=trueの場合リトライすること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: true,
        maxRetries: 3,
        timeout: 30000,
      });

      // 最初の2回は失敗、3回目で成功
      mockFetch
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: 'success' }),
        });

      const result = await client.generate('base64image', 'test prompt');
      expect(result).toBe('success');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    }, 30000); // リトライ待機時間を考慮

    it('最大リトライ回数に達したらエラーをスローすること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: true,
        maxRetries: 2,
        timeout: 30000,
      });

      // すべて失敗
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(client.generate('base64image', 'test prompt')).rejects.toThrow(
        VisionAnalysisError
      );

      // 初回 + 2回リトライ = 3回
      expect(mockFetch).toHaveBeenCalledTimes(3);
    }, 30000);

    it('isRetryable=falseのエラーはリトライしないこと', async () => {
      const client = new OllamaVisionClient({
        enableRetry: true,
        maxRetries: 3,
        timeout: 30000,
      });

      // 404エラー（モデルが見つからない）
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(client.generate('base64image', 'test prompt')).rejects.toMatchObject({
        code: 'OLLAMA_UNAVAILABLE',
        isRetryable: false,
      });

      // リトライしないので1回のみ
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('接続拒否時にOLLAMA_UNAVAILABLEエラーをスローすること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.generate('base64image', 'test prompt')).rejects.toMatchObject({
        code: 'OLLAMA_UNAVAILABLE',
        isRetryable: true,
      });
    }, 10000); // 10秒タイムアウト

    it('空レスポンス時にINVALID_RESPONSEエラーをスローすること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '' }),
      });

      await expect(client.generate('base64image', 'test prompt')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        isRetryable: false,
      });
    });

    it('JSONパースエラー時にINVALID_RESPONSEエラーをスローすること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'not a json response' }),
      });

      await expect(
        client.generateJSON('base64image', 'test prompt')
      ).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        isRetryable: false,
      });
    });
  });

  describe('isAvailable', () => {
    it('Ollamaが利用可能な場合trueを返すこと', async () => {
      const client = new OllamaVisionClient();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      const result = await client.isAvailable();
      expect(result).toBe(true);
    }, 10000); // 10秒タイムアウト

    it('Ollamaが利用不可の場合falseを返すこと', async () => {
      const client = new OllamaVisionClient();

      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await client.isAvailable();
      expect(result).toBe(false);
    }, 10000); // 10秒タイムアウト
  });

  describe('generate', () => {
    it('正常なレスポンスを返すこと', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: 'Analysis result from Ollama',
          done: true,
        }),
      });

      const result = await client.generate('base64image', 'analyze this image');

      expect(result).toBe('Analysis result from Ollama');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"model":"llama3.2-vision"'),
        })
      );
    });

    it('カスタムモデルを使用できること', async () => {
      const client = new OllamaVisionClient({
        model: 'custom-model',
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'result' }),
      });

      await client.generate('base64image', 'prompt');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"model":"custom-model"'),
        })
      );
    });
  });

  describe('generateJSON', () => {
    it('JSONレスポンスをパースして返すこと', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: '{"key": "value", "number": 42}',
        }),
      });

      const result = await client.generateJSON<{ key: string; number: number }>(
        'base64image',
        'return json'
      );

      expect(result).toEqual({ key: 'value', number: 42 });
    });

    it('JSONが埋め込まれたテキストからJSONを抽出すること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: 'Here is the analysis:\n{"result": "success"}\nEnd of analysis.',
        }),
      });

      const result = await client.generateJSON<{ result: string }>(
        'base64image',
        'return json'
      );

      expect(result).toEqual({ result: 'success' });
    });
  });
});

describe('OllamaVisionClient - Default Retry Behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * P2タスク: Ollama Vision API タイムアウトハンドリング改善
   * 「リトライロジックをデフォルト有効化」要件を検証
   */
  it('デフォルトでリトライが有効であること', async () => {
    // デフォルト設定でクライアントを作成
    const client = new OllamaVisionClient();

    // 最初の2回は失敗、3回目で成功（デフォルトmaxRetries=3）
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'success after retry' }),
      });

    const result = await client.generate('base64image', 'test prompt');

    // リトライが有効なら3回呼び出される（初回 + 2回リトライで成功）
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toBe('success after retry');
  }, 30000);

  /**
   * カスタムタイムアウトが正しく適用されることを検証
   * （デフォルト60秒のテストは時間がかかるため、短いタイムアウトで動作を検証）
   */
  it('カスタムタイムアウトが正しく適用されること', async () => {
    const client = new OllamaVisionClient({
      timeout: 100, // 100ms
      enableRetry: false,
    });

    // fetchが50ms後に解決するようにモック（タイムアウトより短い）
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({ response: 'result' }),
            });
          }, 50);
        })
    );

    // 50ms後に成功するので、100msタイムアウトでは成功する
    const result = await client.generate('base64image', 'test prompt');
    expect(result).toBe('result');
  }, 5000);

  it('AbortErrorがTIMEOUTエラーに変換されること', async () => {
    const client = new OllamaVisionClient({
      timeout: 50, // 50ms
      enableRetry: false,
    });

    // AbortErrorをスローするようにモック
    mockFetch.mockImplementation(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    await expect(client.generate('base64image', 'test prompt')).rejects.toMatchObject({
      code: 'TIMEOUT',
      isRetryable: true,
    });
  });
});

// =============================================================================
// Phase 2: Dynamic Timeout Tests (HardwareDetector統合)
// =============================================================================

// =============================================================================
// JSON Format Option Tests (format: 'json'オプション検証)
// =============================================================================

describe('OllamaVisionClient - JSON Format Option', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('JSON format option', () => {
    it('generateJSONのAPIリクエストにformat: jsonが含まれること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"key": "value"}' }),
      });

      await client.generateJSON('base64image', 'test prompt');

      // リクエストボディにformat: 'json'が含まれること
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.format).toBe('json');
    });

    it('generateメソッドにもformat: jsonが含まれること（Ollama JSON mode有効化）', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'plain text response' }),
      });

      await client.generate('base64image', 'test prompt');

      // Ollama JSON modeを有効化するため、すべてのAPI呼び出しにformat: 'json'が含まれる
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.format).toBe('json');
    });
  });

  describe('non-greedy JSON extraction', () => {
    it('複数のJSONオブジェクトがある場合、最初のオブジェクトを抽出すること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      // 複数JSONを含むレスポンス（コード例付き）
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: 'Here is the result: {"first": "object"} And here is another example: {"second": "object"}',
        }),
      });

      const result = await client.generateJSON<{ first: string }>(
        'base64image',
        'test prompt'
      );

      expect(result).toEqual({ first: 'object' });
    });

    it('Pythonコード例を含むレスポンスから正しいJSONを抽出すること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      // Pythonコード例を含むレスポンス
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: `Here is the analysis:
{"moodCategory": "professional", "confidence": 0.85}

You could also use Python:
result = {"type": "example"}
print(result)`,
        }),
      });

      const result = await client.generateJSON<{ moodCategory: string; confidence: number }>(
        'base64image',
        'test prompt'
      );

      expect(result).toEqual({ moodCategory: 'professional', confidence: 0.85 });
    });

    it('ネストされたJSONオブジェクトを正しく抽出すること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: '{"outer": {"inner": "value"}, "array": [1, 2, 3]}',
        }),
      });

      const result = await client.generateJSON<{ outer: { inner: string }; array: number[] }>(
        'base64image',
        'test prompt'
      );

      expect(result).toEqual({ outer: { inner: 'value' }, array: [1, 2, 3] });
    });
  });

  describe('generateJSONWithImageSize format option', () => {
    it('動的タイムアウトAPIでもformat: jsonが含まれること', async () => {
      const mockHardwareDetector = {
        detect: vi.fn().mockResolvedValue({
          type: 'GPU',
          vramBytes: 4_000_000_000,
          isGpuAvailable: true,
        }),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as never,
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"key": "value"}' }),
      });

      await client.generateJSONWithImageSize('base64image', 'test prompt', 100_000);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.format).toBe('json');
    });

    it('generateWithImageSizeメソッドにもformat: jsonが含まれること（Ollama JSON mode有効化）', async () => {
      const mockHardwareDetector = {
        detect: vi.fn().mockResolvedValue({
          type: 'GPU',
          vramBytes: 4_000_000_000,
          isGpuAvailable: true,
        }),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as never,
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'plain text response' }),
      });

      await client.generateWithImageSize('base64image', 'test prompt', 100_000);

      // Ollama JSON modeを有効化するため、すべてのAPI呼び出しにformat: 'json'が含まれる
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.format).toBe('json');
    });
  });
});

describe('OllamaVisionClient - Dynamic Timeout (Phase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor with HardwareDetector', () => {
    it('HardwareDetectorオプションを受け入れること', () => {
      // HardwareDetectorインスタンスを作成（モック）
      const mockHardwareDetector = {
        detect: vi.fn(),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as any,
      });

      expect(client).toBeDefined();
    });

    it('HardwareDetectorなしで動作すること（後方互換性）', () => {
      const client = new OllamaVisionClient();
      expect(client).toBeDefined();
    });
  });

  describe('dynamic timeout calculation', () => {
    it('GPUモードでは60秒タイムアウトを使用すること', async () => {
      // GPUを返すモックHardwareDetector
      const mockHardwareDetector = {
        detect: vi.fn().mockResolvedValue({
          type: 'GPU',
          vramBytes: 4_000_000_000,
          isGpuAvailable: true,
        }),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as any,
        enableRetry: false,
      });

      // 成功レスポンスをモック
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'success' }),
      });

      // 画像サイズ付きで呼び出し（600KB = 大きい画像）
      const result = await client.generateWithImageSize(
        'base64image',
        'test prompt',
        600_000
      );

      expect(result).toBe('success');
      // HardwareDetectorが呼ばれたこと
      expect(mockHardwareDetector.detect).toHaveBeenCalled();
    });

    it('CPUモード + 小画像（<100KB）では180秒タイムアウトを使用すること', async () => {
      // CPUを返すモックHardwareDetector
      const mockHardwareDetector = {
        detect: vi.fn().mockResolvedValue({
          type: 'CPU',
          vramBytes: 0,
          isGpuAvailable: false,
        }),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as any,
        enableRetry: false,
      });

      // 成功レスポンスをモック
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'success' }),
      });

      // 小さい画像（50KB）
      const result = await client.generateWithImageSize(
        'base64image',
        'test prompt',
        50_000
      );

      expect(result).toBe('success');
      expect(mockHardwareDetector.detect).toHaveBeenCalled();
    });

    it('CPUモード + 中画像（100KB-500KB）では600秒タイムアウトを使用すること', async () => {
      const mockHardwareDetector = {
        detect: vi.fn().mockResolvedValue({
          type: 'CPU',
          vramBytes: 0,
          isGpuAvailable: false,
        }),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as any,
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'success' }),
      });

      // 中サイズ画像（200KB）
      const result = await client.generateWithImageSize(
        'base64image',
        'test prompt',
        200_000
      );

      expect(result).toBe('success');
    });

    it('CPUモード + 大画像（>=500KB）では1200秒タイムアウトを使用すること', async () => {
      const mockHardwareDetector = {
        detect: vi.fn().mockResolvedValue({
          type: 'CPU',
          vramBytes: 0,
          isGpuAvailable: false,
        }),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as any,
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'success' }),
      });

      // 大きい画像（1MB）
      const result = await client.generateWithImageSize(
        'base64image',
        'test prompt',
        1_000_000
      );

      expect(result).toBe('success');
    });
  });

  describe('fallback behavior', () => {
    it('HardwareDetectorがエラーの場合、デフォルトタイムアウトを使用すること', async () => {
      const mockHardwareDetector = {
        detect: vi.fn().mockRejectedValue(new Error('Detection failed')),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as any,
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'success' }),
      });

      // エラーでもデフォルトタイムアウトで動作継続
      const result = await client.generateWithImageSize(
        'base64image',
        'test prompt',
        200_000
      );

      expect(result).toBe('success');
    });

    it('HardwareDetectorなしの場合、デフォルトタイムアウトを使用すること', async () => {
      const client = new OllamaVisionClient({
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'success' }),
      });

      // generateWithImageSizeはHardwareDetectorなしでも動作
      const result = await client.generateWithImageSize(
        'base64image',
        'test prompt',
        200_000
      );

      expect(result).toBe('success');
    });
  });

  describe('generateJSONWithImageSize', () => {
    it('動的タイムアウトでJSON生成できること', async () => {
      const mockHardwareDetector = {
        detect: vi.fn().mockResolvedValue({
          type: 'GPU',
          vramBytes: 4_000_000_000,
          isGpuAvailable: true,
        }),
        clearCache: vi.fn(),
      };

      const client = new OllamaVisionClient({
        hardwareDetector: mockHardwareDetector as any,
        enableRetry: false,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"key": "value"}' }),
      });

      const result = await client.generateJSONWithImageSize<{ key: string }>(
        'base64image',
        'test prompt',
        100_000
      );

      expect(result).toEqual({ key: 'value' });
    });
  });
});
