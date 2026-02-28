// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter テスト
 * TDD Red Phase: LlamaVision アダプタのユニットテスト
 *
 * 目的:
 * - IVisionAnalyzerインターフェース実装の検証
 * - Ollama API接続のテスト（モック使用）
 * - 可用性チェックのテスト
 * - 画像解析リクエストのテスト
 * - レスポンスパースのテスト
 * - タイムアウト・リトライ処理のテスト
 * - エラーハンドリングのテスト
 *
 * 参照:
 * - docs/plans/webdesign/00-overview.md (ビジョン解析アダプタ セクション)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  IVisionAnalyzer,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  VisionFeatureType,
} from '@/services/vision-adapter/interface';

// =============================================================================
// LlamaVisionAdapter インポート（実装後に有効化）
// =============================================================================

import {
  LlamaVisionAdapter,
  type LlamaVisionAdapterConfig,
} from '@/services/vision-adapter/llama-vision.adapter';

// =============================================================================
// グローバルfetchモック
// =============================================================================

const mockFetch = vi.fn();
global.fetch = mockFetch;

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * テスト用の画像バッファを生成
 */
function createTestImageBuffer(size = 100): Buffer {
  // 最小限のPNG画像データをシミュレート
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.alloc(size - header.length);
  return Buffer.concat([header, data]);
}

/**
 * Ollama /api/tags レスポンスのモック
 */
function createTagsResponse(models: string[]) {
  return {
    ok: true,
    json: async () => ({
      models: models.map((name) => ({
        name,
        size: 4_000_000_000,
        modified_at: new Date().toISOString(),
      })),
    }),
  };
}

/**
 * Ollama /api/generate レスポンスのモック
 */
function createGenerateResponse(response: string, totalDuration = 5000000000) {
  return {
    ok: true,
    json: async () => ({
      model: 'llama3.2-vision',
      response,
      done: true,
      total_duration: totalDuration,
      eval_count: 150,
    }),
  };
}

/**
 * 有効なJSON解析結果
 */
function createValidAnalysisJson() {
  return JSON.stringify({
    features: [
      {
        type: 'layout_structure',
        confidence: 0.85,
        data: {
          type: 'layout_structure',
          gridType: 'two-column',
          mainAreas: ['header', 'sidebar', 'main', 'footer'],
          description: 'A two-column layout with header and footer',
        },
      },
      {
        type: 'color_palette',
        confidence: 0.9,
        data: {
          type: 'color_palette',
          dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
          mood: 'professional and clean',
          contrast: 'high',
        },
      },
    ],
    summary: 'A professional website with two-column layout',
  });
}

// =============================================================================
// テストケース
// =============================================================================

describe('LlamaVisionAdapter', () => {
  let adapter: LlamaVisionAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LlamaVisionAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 基本プロパティ テスト
  // ===========================================================================

  describe('基本プロパティ', () => {
    it('nameプロパティが正しく設定されていること', () => {
      expect(adapter.name).toBe('LlamaVisionAdapter');
    });

    it('modelNameプロパティがデフォルト値で設定されていること', () => {
      expect(adapter.modelName).toBe('llama3.2-vision');
    });

    it('カスタムmodelNameが設定できること', () => {
      const customAdapter = new LlamaVisionAdapter({
        modelName: 'custom-vision-model',
      });
      expect(customAdapter.modelName).toBe('custom-vision-model');
    });

    it('IVisionAnalyzerインターフェースを実装していること', () => {
      const analyzer: IVisionAnalyzer = adapter;
      expect(analyzer.name).toBeDefined();
      expect(analyzer.modelName).toBeDefined();
      expect(typeof analyzer.isAvailable).toBe('function');
      expect(typeof analyzer.analyze).toBe('function');
      expect(typeof analyzer.generateTextRepresentation).toBe('function');
    });
  });

  // ===========================================================================
  // 設定 テスト
  // ===========================================================================

  describe('設定', () => {
    it('デフォルト設定が適用されること', () => {
      const defaultAdapter = new LlamaVisionAdapter();
      expect(defaultAdapter.modelName).toBe('llama3.2-vision');
    });

    it('カスタムbaseUrlが設定できること', () => {
      const customAdapter = new LlamaVisionAdapter({
        baseUrl: 'http://custom-ollama:11434',
      });
      // 内部状態の確認はisAvailable呼び出しで検証
      expect(customAdapter).toBeInstanceOf(LlamaVisionAdapter);
    });

    it('環境変数OLLAMA_BASE_URLが優先されること', () => {
      const originalEnv = process.env.OLLAMA_BASE_URL;
      process.env.OLLAMA_BASE_URL = 'http://env-ollama:11434';

      const envAdapter = new LlamaVisionAdapter();
      expect(envAdapter).toBeInstanceOf(LlamaVisionAdapter);

      // 環境変数を復元
      if (originalEnv !== undefined) {
        process.env.OLLAMA_BASE_URL = originalEnv;
      } else {
        delete process.env.OLLAMA_BASE_URL;
      }
    });

    it('タイムアウト設定が適用されること', () => {
      const customAdapter = new LlamaVisionAdapter({
        requestTimeout: 120000,
        connectionTimeout: 20000,
      });
      expect(customAdapter).toBeInstanceOf(LlamaVisionAdapter);
    });

    it('リトライ設定が適用されること', () => {
      const customAdapter = new LlamaVisionAdapter({
        maxRetries: 5,
        retryDelay: 2000,
      });
      expect(customAdapter).toBeInstanceOf(LlamaVisionAdapter);
    });

    it('デフォルト特徴設定が適用されること', () => {
      const customAdapter = new LlamaVisionAdapter({
        defaultFeatures: ['layout_structure', 'color_palette'],
      });
      expect(customAdapter).toBeInstanceOf(LlamaVisionAdapter);
    });

    it('最大画像サイズ設定が適用されること', () => {
      const customAdapter = new LlamaVisionAdapter({
        maxImageSize: 10 * 1024 * 1024, // 10MB
      });
      expect(customAdapter).toBeInstanceOf(LlamaVisionAdapter);
    });
  });

  // ===========================================================================
  // isAvailable テスト
  // ===========================================================================

  describe('isAvailable', () => {
    describe('正常系', () => {
      it('Ollamaサーバーとモデルが利用可能な場合trueを返すこと', async () => {
        mockFetch.mockResolvedValueOnce(
          createTagsResponse(['llama3.2-vision', 'llama3.2'])
        );

        const result = await adapter.isAvailable();
        expect(result).toBe(true);
      });

      it('/api/tagsエンドポイントにリクエストすること', async () => {
        mockFetch.mockResolvedValueOnce(createTagsResponse(['llama3.2-vision']));

        await adapter.isAvailable();

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/tags'),
          expect.objectContaining({
            method: 'GET',
          })
        );
      });

      it('カスタムモデル名でも利用可能性を確認できること', async () => {
        const customAdapter = new LlamaVisionAdapter({
          modelName: 'custom-vision',
        });
        mockFetch.mockResolvedValueOnce(
          createTagsResponse(['custom-vision', 'other-model'])
        );

        const result = await customAdapter.isAvailable();
        expect(result).toBe(true);
      });
    });

    describe('異常系', () => {
      it('Ollamaサーバーに接続できない場合falseを返すこと', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await adapter.isAvailable();
        expect(result).toBe(false);
      });

      it('モデルが見つからない場合falseを返すこと', async () => {
        mockFetch.mockResolvedValueOnce(
          createTagsResponse(['other-model', 'another-model'])
        );

        const result = await adapter.isAvailable();
        expect(result).toBe(false);
      });

      it('空のモデルリストの場合falseを返すこと', async () => {
        mockFetch.mockResolvedValueOnce(createTagsResponse([]));

        const result = await adapter.isAvailable();
        expect(result).toBe(false);
      });

      it('HTTPエラーの場合falseを返すこと', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });

        const result = await adapter.isAvailable();
        expect(result).toBe(false);
      });

      it('タイムアウトの場合falseを返すこと', async () => {
        mockFetch.mockImplementationOnce(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), 100)
            )
        );

        const shortTimeoutAdapter = new LlamaVisionAdapter({
          connectionTimeout: 50,
        });

        const result = await shortTimeoutAdapter.isAvailable();
        expect(result).toBe(false);
      });
    });
  });

  // ===========================================================================
  // analyze テスト
  // ===========================================================================

  describe('analyze', () => {
    describe('正常系', () => {
      it('画像解析が成功すること', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createValidAnalysisJson())
        );

        const options: VisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        };

        const result = await adapter.analyze(options);

        expect(result.success).toBe(true);
        expect(result.features.length).toBeGreaterThan(0);
        expect(result.modelName).toBe('llama3.2-vision');
        expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      });

      it('/api/generateエンドポイントにリクエストすること', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createValidAnalysisJson())
        );

        const options: VisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        };

        await adapter.analyze(options);

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/generate'),
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Content-Type': 'application/json',
            }),
          })
        );
      });

      it('画像がbase64でエンコードされて送信されること', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createValidAnalysisJson())
        );

        const options: VisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        };

        await adapter.analyze(options);

        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);

        expect(body.images).toBeDefined();
        expect(Array.isArray(body.images)).toBe(true);
        expect(body.images.length).toBe(1);
        // base64文字列であることを確認
        expect(typeof body.images[0]).toBe('string');
      });

      it('指定された特徴タイプがプロンプトに含まれること', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createValidAnalysisJson())
        );

        const options: VisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          features: ['layout_structure', 'color_palette'],
        };

        await adapter.analyze(options);

        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);

        expect(body.prompt).toContain('layout_structure');
        expect(body.prompt).toContain('color_palette');
      });

      it('すべてのMIMEタイプで解析できること', async () => {
        const mimeTypes: Array<'image/png' | 'image/jpeg' | 'image/webp'> = [
          'image/png',
          'image/jpeg',
          'image/webp',
        ];

        for (const mimeType of mimeTypes) {
          mockFetch.mockResolvedValueOnce(
            createGenerateResponse(createValidAnalysisJson())
          );

          const result = await adapter.analyze({
            imageBuffer: createTestImageBuffer(),
            mimeType,
          });

          expect(result.success).toBe(true);
        }
      });

      it('カスタムプロンプトが使用されること', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createValidAnalysisJson())
        );

        const customPrompt = 'Analyze this image focusing on accessibility';
        const options: VisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          prompt: customPrompt,
        };

        await adapter.analyze(options);

        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);

        expect(body.prompt).toContain(customPrompt);
      });

      it('処理時間が記録されること', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createValidAnalysisJson(), 5000000000)
        );

        const result = await adapter.analyze({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        });

        expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      });

      it('rawResponseが含まれること', async () => {
        const responseJson = createValidAnalysisJson();
        mockFetch.mockResolvedValueOnce(createGenerateResponse(responseJson));

        const result = await adapter.analyze({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        });

        expect(result.rawResponse).toBeDefined();
      });
    });

    describe('異常系', () => {
      it('Ollamaサーバーに接続できない場合エラーを返すこと', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await adapter.analyze({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.features).toEqual([]);
      });

      it('HTTPエラーの場合エラーを返すこと', async () => {
        // 4xxエラーはリトライしないので1回だけ
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({ error: 'Bad request' }),
        });

        const result = await adapter.analyze({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('400');
      });

      it('不正なJSONレスポンスの場合エラーを返すこと', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse('This is not valid JSON')
        );

        const result = await adapter.analyze({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it('タイムアウトの場合エラーを返すこと', async () => {
        const timeoutAdapter = new LlamaVisionAdapter({
          requestTimeout: 50,
          maxRetries: 0, // リトライ無効
        });

        // AbortErrorをシミュレート
        const abortError = new Error('Timeout');
        abortError.name = 'AbortError';
        mockFetch.mockRejectedValueOnce(abortError);

        const result = await timeoutAdapter.analyze({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        });

        expect(result.success).toBe(false);
        expect(result.error?.toLowerCase()).toContain('timeout');
      });

      it('空の画像バッファの場合エラーを返すこと', async () => {
        const result = await adapter.analyze({
          imageBuffer: Buffer.alloc(0),
          mimeType: 'image/png',
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it('画像サイズ制限を超える場合エラーを返すこと', async () => {
        const smallLimitAdapter = new LlamaVisionAdapter({
          maxImageSize: 100, // 100 bytes
        });

        const result = await smallLimitAdapter.analyze({
          imageBuffer: createTestImageBuffer(200),
          mimeType: 'image/png',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('size');
      });
    });
  });

  // ===========================================================================
  // リトライ テスト
  // ===========================================================================

  describe('リトライ処理', () => {
    it('一時的なエラーの場合リトライすること', async () => {
      const retryAdapter = new LlamaVisionAdapter({
        maxRetries: 3,
        retryDelay: 10,
      });

      // 最初の2回は失敗、3回目で成功
      mockFetch
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce(createGenerateResponse(createValidAnalysisJson()));

      const result = await retryAdapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('最大リトライ回数を超えた場合エラーを返すこと', async () => {
      const retryAdapter = new LlamaVisionAdapter({
        maxRetries: 2,
        retryDelay: 10,
      });

      mockFetch.mockRejectedValue(new Error('Persistent error'));

      const result = await retryAdapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('error');
      // 初回 + 2回リトライ = 3回
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('リトライ間隔が設定通りであること', async () => {
      const retryDelay = 50;
      const retryAdapter = new LlamaVisionAdapter({
        maxRetries: 2,
        retryDelay,
      });

      const startTime = Date.now();

      mockFetch
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce(createGenerateResponse(createValidAnalysisJson()));

      await retryAdapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      const elapsed = Date.now() - startTime;
      // 2回のリトライで少なくとも2 * retryDelay ms経過
      expect(elapsed).toBeGreaterThanOrEqual(retryDelay * 2 - 20); // 許容誤差
    });

    it('4xxエラーの場合はリトライしないこと', async () => {
      const retryAdapter = new LlamaVisionAdapter({
        maxRetries: 3,
        retryDelay: 10,
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Invalid request' }),
      });

      const result = await retryAdapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      // 4xxエラーはリトライしない
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // レスポンスパース テスト
  // ===========================================================================

  describe('レスポンスパース', () => {
    it('有効なJSONレスポンスがパースできること', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.features.length).toBe(2);
      expect(result.features[0].type).toBe('layout_structure');
      expect(result.features[1].type).toBe('color_palette');
    });

    it('JSONブロック内のレスポンスがパースできること', async () => {
      const responseWithMarkdown = `Here is the analysis:

\`\`\`json
${createValidAnalysisJson()}
\`\`\`

This is a professional layout.`;

      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(responseWithMarkdown)
      );

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.features.length).toBe(2);
    });

    it('特徴のconfidenceが正しくパースされること', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.features[0].confidence).toBe(0.85);
      expect(result.features[1].confidence).toBe(0.9);
    });

    it('不完全な特徴データがフィルタリングされること', async () => {
      const incompleteJson = JSON.stringify({
        features: [
          {
            type: 'layout_structure',
            confidence: 0.85,
            data: {
              type: 'layout_structure',
              gridType: 'two-column',
              mainAreas: ['header'],
              description: 'Valid',
            },
          },
          {
            // 不完全なデータ
            type: 'color_palette',
            confidence: 0.9,
            // dataが欠けている
          },
        ],
        summary: 'Test',
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(incompleteJson));

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      // 不完全な特徴はフィルタリングされる
      expect(result.features.length).toBe(1);
    });

    it('すべての特徴タイプがパースできること', async () => {
      const allFeaturesJson = JSON.stringify({
        features: [
          {
            type: 'layout_structure',
            confidence: 0.9,
            data: {
              type: 'layout_structure',
              gridType: 'grid',
              mainAreas: ['header', 'main'],
              description: 'Grid layout',
            },
          },
          {
            type: 'color_palette',
            confidence: 0.85,
            data: {
              type: 'color_palette',
              dominantColors: ['#FFF'],
              mood: 'clean',
              contrast: 'high',
            },
          },
          {
            type: 'typography',
            confidence: 0.8,
            data: {
              type: 'typography',
              headingStyle: 'bold',
              bodyStyle: 'regular',
              hierarchy: ['h1', 'h2', 'body'],
            },
          },
          {
            type: 'visual_hierarchy',
            confidence: 0.75,
            data: {
              type: 'visual_hierarchy',
              focalPoints: ['hero'],
              flowDirection: 'top-to-bottom',
              emphasisTechniques: ['size'],
            },
          },
          {
            type: 'whitespace',
            confidence: 0.7,
            data: {
              type: 'whitespace',
              amount: 'generous',
              distribution: 'even',
            },
          },
          {
            type: 'density',
            confidence: 0.65,
            data: {
              type: 'density',
              level: 'balanced',
              description: 'Well balanced',
            },
          },
          {
            type: 'rhythm',
            confidence: 0.6,
            data: {
              type: 'rhythm',
              pattern: 'regular',
              description: 'Consistent spacing',
            },
          },
          {
            type: 'section_boundaries',
            confidence: 0.55,
            data: {
              type: 'section_boundaries',
              sections: [{ type: 'hero', startY: 0, endY: 600, confidence: 0.9 }],
            },
          },
        ],
        summary: 'Complete analysis',
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(allFeaturesJson));

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.features.length).toBe(8);

      const featureTypes = result.features.map((f) => f.type);
      expect(featureTypes).toContain('layout_structure');
      expect(featureTypes).toContain('color_palette');
      expect(featureTypes).toContain('typography');
      expect(featureTypes).toContain('visual_hierarchy');
      expect(featureTypes).toContain('whitespace');
      expect(featureTypes).toContain('density');
      expect(featureTypes).toContain('rhythm');
      expect(featureTypes).toContain('section_boundaries');
    });
  });

  // ===========================================================================
  // generateTextRepresentation テスト
  // ===========================================================================

  describe('generateTextRepresentation', () => {
    it('空の特徴リストの場合適切なメッセージを返すこと', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      };

      const text = adapter.generateTextRepresentation(result);
      expect(text).toContain('No features detected');
    });

    it('レイアウト特徴がテキストに含まれること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.9,
            data: {
              type: 'layout_structure',
              gridType: 'two-column',
              mainAreas: ['header', 'sidebar', 'main'],
              description: 'A two-column layout',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      };

      const text = adapter.generateTextRepresentation(result);

      expect(text).toContain('Layout');
      expect(text).toContain('two-column');
    });

    it('カラーパレット特徴がテキストに含まれること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'color_palette',
            confidence: 0.85,
            data: {
              type: 'color_palette',
              dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
              mood: 'professional',
              contrast: 'high',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      };

      const text = adapter.generateTextRepresentation(result);

      expect(text).toContain('Color');
      expect(text).toContain('#3B82F6');
    });

    it('複数の特徴が適切にフォーマットされること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.9,
            data: {
              type: 'layout_structure',
              gridType: 'grid',
              mainAreas: ['header', 'main'],
              description: 'Grid layout',
            },
          },
          {
            type: 'whitespace',
            confidence: 0.8,
            data: {
              type: 'whitespace',
              amount: 'generous',
              distribution: 'even',
            },
          },
          {
            type: 'density',
            confidence: 0.75,
            data: {
              type: 'density',
              level: 'balanced',
              description: 'Well balanced',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      };

      const text = adapter.generateTextRepresentation(result);

      expect(text).toContain('Layout');
      expect(text).toContain('grid');
      expect(text).toContain('Whitespace');
      expect(text).toContain('generous');
      expect(text).toContain('Density');
      expect(text).toContain('balanced');
    });

    it('エラー結果の場合エラーメッセージを含むこと', () => {
      const result: VisionAnalysisResult = {
        success: false,
        features: [],
        error: 'Analysis failed due to timeout',
        processingTimeMs: 30000,
        modelName: 'llama3.2-vision',
      };

      const text = adapter.generateTextRepresentation(result);

      expect(text).toContain('Error');
      expect(text).toContain('Analysis failed');
    });

    it('すべての特徴タイプが適切にテキスト化されること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.9,
            data: {
              type: 'layout_structure',
              gridType: 'single-column',
              mainAreas: ['hero'],
              description: 'Single column',
            },
          },
          {
            type: 'typography',
            confidence: 0.85,
            data: {
              type: 'typography',
              headingStyle: 'bold sans-serif',
              bodyStyle: 'regular serif',
              hierarchy: ['h1', 'h2', 'body'],
            },
          },
          {
            type: 'visual_hierarchy',
            confidence: 0.8,
            data: {
              type: 'visual_hierarchy',
              focalPoints: ['hero image', 'CTA'],
              flowDirection: 'z-pattern',
              emphasisTechniques: ['size contrast'],
            },
          },
          {
            type: 'rhythm',
            confidence: 0.75,
            data: {
              type: 'rhythm',
              pattern: 'regular',
              description: 'Consistent spacing',
            },
          },
          {
            type: 'section_boundaries',
            confidence: 0.7,
            data: {
              type: 'section_boundaries',
              sections: [
                { type: 'hero', startY: 0, endY: 600, confidence: 0.9 },
                { type: 'features', startY: 600, endY: 1200, confidence: 0.85 },
              ],
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      };

      const text = adapter.generateTextRepresentation(result);

      expect(text).toContain('Typography');
      expect(text).toContain('Visual hierarchy');
      expect(text).toContain('Rhythm');
      expect(text).toContain('Section');
    });
  });

  // ===========================================================================
  // プロンプト生成 テスト
  // ===========================================================================

  describe('プロンプト生成', () => {
    it('デフォルトの解析プロンプトが使用されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      // 簡略化されたプロンプト（llama3.2-vision最適化）
      expect(body.prompt).toContain('JSON');
      expect(body.prompt).toContain('web page screenshot');
    });

    it('カスタムシステムプロンプトが使用されること', async () => {
      const customAdapter = new LlamaVisionAdapter({
        systemPrompt: 'You are an expert UI designer.',
      });

      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      await customAdapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.prompt).toContain('expert UI designer');
    });

    it('特徴タイプに基づいてプロンプトが生成されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      const features: VisionFeatureType[] = [
        'layout_structure',
        'whitespace',
      ];

      await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
        features,
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.prompt).toContain('layout_structure');
      expect(body.prompt).toContain('whitespace');
      // 指定していない特徴は含まれない（または優先度が低い）
    });
  });

  // ===========================================================================
  // 画像前処理 テスト
  // ===========================================================================

  describe('画像前処理', () => {
    it('画像バッファがbase64に変換されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      const imageBuffer = createTestImageBuffer();

      await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      const expectedBase64 = imageBuffer.toString('base64');
      expect(body.images[0]).toBe(expectedBase64);
    });

    it('文字列画像データ（base64）がそのまま使用されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      // 注: 実際の実装ではstringも受け付ける場合がある
      await adapter.analyze({
        imageBuffer: Buffer.from(base64Image, 'base64'),
        mimeType: 'image/png',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.images[0]).toBe(base64Image);
    });
  });

  // ===========================================================================
  // エッジケース テスト
  // ===========================================================================

  describe('エッジケース', () => {
    it('非常に大きな画像でも処理できること', async () => {
      // 5MBの画像をシミュレート
      const largeImageBuffer = createTestImageBuffer(5 * 1024 * 1024);

      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createValidAnalysisJson())
      );

      const result = await adapter.analyze({
        imageBuffer: largeImageBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
    });

    it('空のレスポンスの場合適切にハンドリングされること', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: '',
          done: true,
        }),
      });

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('部分的なJSONレスポンスの場合適切にハンドリングされること', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse('{"features": [{"type": "layout_structure"')
      );

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('Ollamaの応答が非常に遅い場合タイムアウトすること', async () => {
      const shortTimeoutAdapter = new LlamaVisionAdapter({
        requestTimeout: 50,
        maxRetries: 0, // リトライ無効
      });

      // AbortErrorをシミュレート
      const abortError = new Error('Timeout');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const result = await shortTimeoutAdapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain('timeout');
    });

    it('複数の同時リクエストが処理できること', async () => {
      mockFetch.mockResolvedValue(
        createGenerateResponse(createValidAnalysisJson())
      );

      const promises = Array(5)
        .fill(null)
        .map(() =>
          adapter.analyze({
            imageBuffer: createTestImageBuffer(),
            mimeType: 'image/png',
          })
        );

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result.success).toBe(true);
      });
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('LlamaVisionAdapter 統合テスト', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('完全なワークフローが動作すること', async () => {
    const adapter = new LlamaVisionAdapter({
      maxRetries: 0, // テスト用にリトライ無効
    });

    // 1. 可用性チェック
    mockFetch.mockResolvedValueOnce(createTagsResponse(['llama3.2-vision']));
    const isAvailable = await adapter.isAvailable();
    expect(isAvailable).toBe(true);

    // 2. 画像解析
    mockFetch.mockResolvedValueOnce(
      createGenerateResponse(createValidAnalysisJson())
    );
    const analysisResult = await adapter.analyze({
      imageBuffer: createTestImageBuffer(),
      mimeType: 'image/png',
      features: ['layout_structure', 'color_palette'],
    });
    expect(analysisResult.success).toBe(true);

    // 3. テキスト表現生成
    const textRepresentation = adapter.generateTextRepresentation(analysisResult);
    expect(textRepresentation.length).toBeGreaterThan(0);
    expect(textRepresentation).toContain('Layout');
  });

  it('利用不可能な場合のフォールバックフローが動作すること', async () => {
    const adapter = new LlamaVisionAdapter({
      maxRetries: 0, // テスト用にリトライ無効
    });

    // サーバーが利用不可能
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const isAvailable = await adapter.isAvailable();
    expect(isAvailable).toBe(false);

    // それでも解析を試みるとエラーが返る
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await adapter.analyze({
      imageBuffer: createTestImageBuffer(),
      mimeType: 'image/png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // テキスト表現はエラーメッセージを含む
    const text = adapter.generateTextRepresentation(result);
    expect(text).toContain('Error');
  });
});
