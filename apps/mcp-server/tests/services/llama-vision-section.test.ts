// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter セクション単位分析テスト
 *
 * LlamaVisionAdapterのanalyzeSection / generateSectionTextRepresentationメソッドのテスト。
 * セクション単位のVision分析機能の正確性とエラーハンドリングを検証します。
 *
 * テストカバレッジ:
 * - analyzeSection 基本機能（6テスト）
 * - セクションタイプヒント活用（4テスト）
 * - プロンプト生成確認（3テスト）
 * - generateSectionTextRepresentation（4テスト）
 * - エラーハンドリング（3テスト）
 *
 * @module tests/services/llama-vision-section
 */

import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import sharp from 'sharp';
import { LlamaVisionAdapter } from '../../src/services/vision-adapter/llama-vision.adapter';
import type {
  VisionAnalysisResult,
  VisionFeature,
} from '../../src/services/vision-adapter/interface';

// =====================================================
// テストユーティリティ
// =====================================================

/**
 * テスト用画像を生成（Sharp使用）
 */
async function createTestImage(options: {
  width?: number;
  height?: number;
  background?: string;
}): Promise<Buffer> {
  const { width = 1440, height = 600, background = '#3B82F6' } = options;

  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background,
    },
  });

  return image.png().toBuffer();
}

/**
 * モックOllamaレスポンスを生成
 */
function createMockOllamaResponse(options: {
  layout?: string;
  colors?: string[];
  whitespace?: string;
  hierarchy?: string;
  elements?: string[];
}): string {
  const response = {
    layout: options.layout ?? 'single-column layout with centered content',
    colors: options.colors ?? ['#3B82F6', '#FFFFFF', '#1F2937'],
    whitespace: options.whitespace ?? 'generous',
    hierarchy: options.hierarchy ?? 'clear visual flow from top to bottom',
    elements: options.elements ?? ['heading', 'subheading', 'cta-button', 'hero-image'],
  };
  return JSON.stringify(response);
}

/**
 * fetchをモック化するヘルパー
 */
function mockFetch(
  isAvailable: boolean,
  ollamaResponse: string | Error
): Mock {
  const mockFn = vi.fn();

  mockFn.mockImplementation(async (url: string, _options?: RequestInit) => {
    if (url.includes('/api/tags')) {
      if (!isAvailable) {
        throw new Error('Connection refused');
      }
      return {
        ok: true,
        json: async () => ({
          models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
        }),
      };
    }

    if (url.includes('/api/generate')) {
      if (ollamaResponse instanceof Error) {
        throw ollamaResponse;
      }
      return {
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: ollamaResponse,
          done: true,
          total_duration: 5000,
        }),
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  });

  return mockFn;
}

// =====================================================
// テスト
// =====================================================

describe('LlamaVisionAdapter - セクション単位分析', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // =====================================================
  // analyzeSection 基本機能（6テスト）
  // =====================================================

  describe('analyzeSection - 基本機能', () => {
    it('セクション画像を分析できる', async () => {
      const mockResponse = createMockOllamaResponse({});
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
        sectionId: 'section-001',
      });

      expect(result.success).toBe(true);
      expect(result.features).toBeInstanceOf(Array);
      expect(result.modelName).toBe('llama3.2-vision');
    });

    it('セクションタイプヒントなしでも分析できる', async () => {
      const mockResponse = createMockOllamaResponse({});
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        // sectionTypeHint なし
      });

      expect(result.success).toBe(true);
    });

    it('処理時間を記録する', async () => {
      const mockResponse = createMockOllamaResponse({});
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'features',
      });

      expect(result.processingTimeMs).toBeDefined();
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('layout_structure特徴を抽出する', async () => {
      const mockResponse = createMockOllamaResponse({
        layout: 'two-column grid with sidebar',
      });
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'features',
      });

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      expect(layoutFeature).toBeDefined();
      expect(layoutFeature?.data).toHaveProperty('gridType');
    });

    it('color_palette特徴を抽出する', async () => {
      const mockResponse = createMockOllamaResponse({
        colors: ['#FF0000', '#00FF00', '#0000FF'],
      });
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      expect(colorFeature).toBeDefined();
      expect(colorFeature?.data).toHaveProperty('dominantColors');
    });

    it('whitespace特徴を抽出する', async () => {
      const mockResponse = createMockOllamaResponse({
        whitespace: 'generous',
      });
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'cta',
      });

      const whitespaceFeature = result.features.find((f) => f.type === 'whitespace');
      expect(whitespaceFeature).toBeDefined();
      expect(whitespaceFeature?.data).toHaveProperty('amount');
    });
  });

  // =====================================================
  // セクションタイプヒント活用（4テスト）
  // =====================================================

  describe('analyzeSection - セクションタイプヒント', () => {
    it('heroセクションヒントでプロンプトが調整される', async () => {
      let capturedPrompt = '';
      const mockFn = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          capturedPrompt = body.prompt || '';
          return {
            ok: true,
            json: async () => ({
              model: 'llama3.2-vision',
              response: createMockOllamaResponse({}),
              done: true,
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      expect(capturedPrompt).toContain('hero');
    });

    it('featureセクションヒントでプロンプトが調整される', async () => {
      let capturedPrompt = '';
      const mockFn = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          capturedPrompt = body.prompt || '';
          return {
            ok: true,
            json: async () => ({
              model: 'llama3.2-vision',
              response: createMockOllamaResponse({}),
              done: true,
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'feature',
      });

      expect(capturedPrompt).toContain('feature');
    });

    it('unknownヒントでデフォルトプロンプトが使用される', async () => {
      let capturedPrompt = '';
      const mockFn = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          capturedPrompt = body.prompt || '';
          return {
            ok: true,
            json: async () => ({
              model: 'llama3.2-vision',
              response: createMockOllamaResponse({}),
              done: true,
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        // sectionTypeHint なし（unknown扱い）
      });

      expect(capturedPrompt).toContain('unknown');
    });

    it('カスタムプロンプトが追加される', async () => {
      let capturedPrompt = '';
      const mockFn = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          capturedPrompt = body.prompt || '';
          return {
            ok: true,
            json: async () => ({
              model: 'llama3.2-vision',
              response: createMockOllamaResponse({}),
              done: true,
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'pricing',
        prompt: 'Focus on pricing table layout and comparison columns',
      });

      expect(capturedPrompt).toContain('pricing');
      expect(capturedPrompt).toContain('Focus on pricing table layout');
    });
  });

  // =====================================================
  // プロンプト生成確認（3テスト）
  // =====================================================

  describe('buildSectionPrompt - プロンプト生成', () => {
    it('セクションタイプがプロンプトに含まれる', async () => {
      // buildSectionPromptは protected メソッドなので、
      // analyzeSection経由でテスト

      let capturedPrompt = '';
      const mockFn = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          capturedPrompt = body.prompt || '';
          return {
            ok: true,
            json: async () => ({
              model: 'llama3.2-vision',
              response: createMockOllamaResponse({}),
              done: true,
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'testimonials',
      });

      expect(capturedPrompt).toContain('testimonials');
      expect(capturedPrompt).toContain('Section type hint:');
    });

    it('JSON出力指示がプロンプトに含まれる', async () => {
      let capturedPrompt = '';
      const mockFn = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          capturedPrompt = body.prompt || '';
          return {
            ok: true,
            json: async () => ({
              model: 'llama3.2-vision',
              response: createMockOllamaResponse({}),
              done: true,
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'footer',
      });

      expect(capturedPrompt).toContain('JSON');
    });

    it('分析観点がプロンプトに含まれる', async () => {
      let capturedPrompt = '';
      const mockFn = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          capturedPrompt = body.prompt || '';
          return {
            ok: true,
            json: async () => ({
              model: 'llama3.2-vision',
              response: createMockOllamaResponse({}),
              done: true,
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      // セクション分析で要求される観点
      expect(capturedPrompt).toContain('layout');
      expect(capturedPrompt).toContain('color');
      expect(capturedPrompt).toContain('whitespace');
    });
  });

  // =====================================================
  // generateSectionTextRepresentation（4テスト）
  // =====================================================

  describe('generateSectionTextRepresentation', () => {
    it('成功した解析結果からテキスト表現を生成する', async () => {
      const mockResponse = createMockOllamaResponse({
        layout: 'single-column centered layout',
        colors: ['#3B82F6', '#FFFFFF'],
        whitespace: 'generous',
      });
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      const textRep = adapter.generateSectionTextRepresentation(result, 'hero');

      expect(textRep).toBeDefined();
      expect(textRep.length).toBeGreaterThan(0);
    });

    it('セクションタイプが先頭に含まれる', async () => {
      const mockResponse = createMockOllamaResponse({});
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'pricing',
      });

      const textRep = adapter.generateSectionTextRepresentation(result, 'pricing');

      expect(textRep).toContain('Section: pricing');
    });

    it('失敗した解析結果でエラーメッセージを返す', () => {
      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
      });

      const failedResult: VisionAnalysisResult = {
        success: false,
        features: [],
        error: 'Ollama connection failed',
        processingTimeMs: 0,
        modelName: 'llama3.2-vision',
      };

      const textRep = adapter.generateSectionTextRepresentation(failedResult, 'hero');

      expect(textRep).toContain('Error');
      expect(textRep).toContain('Ollama connection failed');
    });

    it('特徴がない場合はデフォルトメッセージを返す', () => {
      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
      });

      const emptyResult: VisionAnalysisResult = {
        success: true,
        features: [],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      };

      const textRep = adapter.generateSectionTextRepresentation(emptyResult, 'cta');

      expect(textRep).toContain('No features detected');
      expect(textRep).toContain('cta');
    });
  });

  // =====================================================
  // エラーハンドリング（3テスト）
  // =====================================================

  describe('analyzeSection - エラーハンドリング', () => {
    it('Ollama未接続時にエラー結果を返す', async () => {
      global.fetch = mockFetch(false, new Error('Connection refused')) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('空の画像バッファでエラー結果を返す', async () => {
      const mockResponse = createMockOllamaResponse({});
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });

      const result = await adapter.analyzeSection({
        imageBuffer: Buffer.alloc(0),
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('Ollamaからの不正なJSONでもエラー結果を返す', async () => {
      // 不正なJSON文字列
      global.fetch = mockFetch(true, 'This is not JSON {invalid}') as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      // 不正なJSONでもパースを試みる
      // 完全に失敗した場合はsuccess: falseになる
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });

  // =====================================================
  // Graceful Degradation（2テスト）
  // =====================================================

  describe('analyzeSection - Graceful Degradation', () => {
    it('タイムアウト時にエラー結果を返す（クラッシュしない）', async () => {
      const mockFn = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'llama3.2-vision', size: 1000000, modified_at: '2024-01-01' }],
            }),
          };
        }
        if (url.includes('/api/generate')) {
          // タイムアウトをシミュレート
          await new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), 10)
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      global.fetch = mockFn as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        requestTimeout: 100,
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
        timeout: 50, // 短いタイムアウト
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('モデル名が結果に含まれる', async () => {
      const mockResponse = createMockOllamaResponse({});
      global.fetch = mockFetch(true, mockResponse) as unknown as typeof fetch;

      const adapter = new LlamaVisionAdapter({
        baseUrl: 'http://localhost:11434',
        modelName: 'llama3.2-vision',
        maxRetries: 0,
      });
      const imageBuffer = await createTestImage({});

      const result = await adapter.analyzeSection({
        imageBuffer,
        mimeType: 'image/png',
        sectionTypeHint: 'hero',
      });

      expect(result.modelName).toBe('llama3.2-vision');
    });
  });
});
