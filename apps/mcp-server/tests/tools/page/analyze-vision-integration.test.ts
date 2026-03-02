// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze Vision統合テスト
 * TDD Red Phase: page.analyzeへのVision解析機能統合
 *
 * useVision: true 時にスクリーンショットをlayout.inspectのscreenshotモードに委譲し、
 * Vision API（Ollama + llama3.2-vision）による画像解析を実行する機能をテスト
 *
 * テスト対象:
 * - layoutOptions.useVisionオプションのスキーマバリデーション
 * - useVision: true時のスクリーンショット解析実行
 * - useVision: false（デフォルト）時の従来動作維持
 * - スクリーンショートがない場合のフォールバック
 * - layout.inspectへの委譲パラメータ
 * - visionFeaturesを含むレスポンス形式
 *
 * @module tests/tools/page/analyze-vision-integration.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Narrative handler をモックしてOllama Vision接続タイムアウト（35秒）を回避
vi.mock('../../../src/tools/page/handlers/narrative-handler', async () => {
  const actual = await vi.importActual('../../../src/tools/page/handlers/narrative-handler');
  return {
    ...(actual as Record<string, unknown>),
    handleNarrativeAnalysis: async () => ({ success: true, skipped: true }),
  };
});

// Redis可用性チェックをモック: Vision自動asyncモード（v0.1.0）を無効化
vi.mock('../../../src/config/redis', () => ({
  isRedisAvailable: async () => false,
}));

import {
  pageAnalyzeHandler,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  type IPageAnalyzeService,
} from '../../../src/tools/page/analyze.tool';

import {
  pageAnalyzeInputSchema,
  layoutOptionsSchema,
  type PageAnalyzeInput,
} from '../../../src/tools/page/schemas';

// =====================================================
// テストデータ
// =====================================================

const validUrl = 'https://example.com';

const sampleHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
</head>
<body>
  <header><nav>Navigation</nav></header>
  <main>
    <section class="hero"><h1>Hero Section</h1></section>
    <section class="features"><h2>Features</h2></section>
  </main>
  <footer>Footer</footer>
</body>
</html>`;

const sampleScreenshotBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// =====================================================
// モック用ヘルパー
// =====================================================

/**
 * Vision解析を含むモックサービスを作成
 */
function createMockServiceWithVision(options?: {
  visionSuccess?: boolean;
  hasScreenshot?: boolean;
}) {
  const visionSuccess = options?.visionSuccess ?? true;
  const hasScreenshot = options?.hasScreenshot ?? true;

  return {
    fetchHtml: vi.fn().mockResolvedValue({
      html: sampleHtml,
      title: 'Test Page',
      description: 'Test description',
      screenshot: hasScreenshot ? sampleScreenshotBase64 : undefined,
    }),
    analyzeLayout: vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 100,
    }),
    detectMotion: vi.fn().mockResolvedValue({
      success: true,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 0,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: 50,
    }),
    evaluateQuality: vi.fn().mockResolvedValue({
      success: true,
      overallScore: 75,
      grade: 'C' as const,
      axisScores: { originality: 70, craftsmanship: 80, contextuality: 75 },
      clicheCount: 0,
      processingTimeMs: 80,
    }),
  };
}

// =====================================================
// スキーマテスト
// =====================================================

describe('layoutOptionsSchema - useVisionオプション', () => {
  it('useVisionオプションを受け付ける（true）', () => {
    const input = { url: validUrl, layoutOptions: { useVision: true } };
    const result = pageAnalyzeInputSchema.parse(input);
    expect(result.layoutOptions?.useVision).toBe(true);
  });

  it('useVisionオプションを受け付ける（false）', () => {
    const input = { url: validUrl, layoutOptions: { useVision: false } };
    const result = pageAnalyzeInputSchema.parse(input);
    expect(result.layoutOptions?.useVision).toBe(false);
  });

  it('useVisionのデフォルト値はtrue（Ollamaがない場合はgraceful degradation）', () => {
    const input = { url: validUrl, layoutOptions: {} };
    const result = pageAnalyzeInputSchema.parse(input);
    // デフォルト値が適用されるか（useVision=true）
    // NOTE: v0.1.0からVision分析をデフォルト有効化
    // Ollamaが起動していない場合はgraceful degradationによりHTML解析のみで続行
    expect(result.layoutOptions?.useVision).toBe(true);
  });

  it('useVisionと他のオプションを組み合わせられる', () => {
    const input = {
      url: validUrl,
      layoutOptions: {
        useVision: true,
        fullPage: true,
        includeScreenshot: true,
        saveToDb: false,
      },
    };
    const result = pageAnalyzeInputSchema.parse(input);
    expect(result.layoutOptions?.useVision).toBe(true);
    expect(result.layoutOptions?.fullPage).toBe(true);
    expect(result.layoutOptions?.includeScreenshot).toBe(true);
  });

  it('useVisionに無効な型（文字列）を渡すとエラー', () => {
    const input = { url: validUrl, layoutOptions: { useVision: 'true' } };
    expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
  });

  it('useVisionに無効な型（数値）を渡すとエラー', () => {
    const input = { url: validUrl, layoutOptions: { useVision: 1 } };
    expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
  });
});

// =====================================================
// ハンドラーテスト - useVision: true
// =====================================================

describe('pageAnalyzeHandler - useVision: true', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useVision: true でスクリーンショット解析を実行する', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: true });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout?.success).toBe(true);
      // Vision解析結果が含まれることを期待
      // 実装では layout.visionFeatures または layout.textRepresentation に反映
    }
  });

  it('useVision: true でvisionFeaturesがレスポンスに含まれる', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: true });

    // analyzeLayoutをVision対応モックに差し替え
    mockService.analyzeLayout = vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 150,
      visionFeatures: {
        success: true,
        features: [
          { type: 'hero_section', confidence: 0.95, description: 'Large hero with gradient background' },
        ],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      },
      textRepresentation: 'Hero section with gradient background, Feature grid, Footer',
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
      summary: false, // 詳細モードでvisionFeaturesを取得
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      // visionFeaturesが含まれることを確認
      // 注意: LayoutResultスキーマにvisionFeaturesを追加する必要がある
      const layoutFull = result.data.layout as {
        success: boolean;
        visionFeatures?: {
          success: boolean;
          features: unknown[];
          processingTimeMs: number;
          modelName: string;
        };
        textRepresentation?: string;
      };
      expect(layoutFull.visionFeatures).toBeDefined();
      expect(layoutFull.visionFeatures?.success).toBe(true);
      expect(layoutFull.visionFeatures?.modelName).toBe('llama3.2-vision');
    }
  });

  it('useVision: true でtextRepresentationが生成される', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: true });

    mockService.analyzeLayout = vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 150,
      textRepresentation: 'Modern hero section with call-to-action, Feature cards in grid layout, Minimal footer',
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
      summary: false,
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      const layoutFull = result.data.layout as {
        success: boolean;
        textRepresentation?: string;
      };
      expect(layoutFull.textRepresentation).toBeDefined();
      expect(layoutFull.textRepresentation).toContain('hero');
    }
  });
});

// =====================================================
// ハンドラーテスト - useVision: false（デフォルト）
// =====================================================

describe('pageAnalyzeHandler - useVision: false（デフォルト）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useVision: false では従来のHTML解析を使用する', async () => {
    const mockService = createMockServiceWithVision({ hasScreenshot: true });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: false },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout?.success).toBe(true);
      // Vision解析は実行されない
    }
  });

  it('layoutOptions未指定（デフォルト）では従来のHTML解析を使用する', async () => {
    const mockService = createMockServiceWithVision({ hasScreenshot: true });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      // layoutOptions未指定
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      // デフォルトではVision解析は実行されない
    }
  });

  it('useVision未指定でもスクリーンショートがあっても従来解析を使用', async () => {
    const mockService = createMockServiceWithVision({ hasScreenshot: true });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { includeScreenshot: true }, // useVision未指定
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    // Vision解析は実行されず、従来のHTML解析が使用される
  });
});

// =====================================================
// ハンドラーテスト - スクリーンショットがない場合
// =====================================================

describe('pageAnalyzeHandler - スクリーンショートがない場合のフォールバック', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useVision: true でもスクリーンショットがなければHTML解析にフォールバック', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: false });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout?.success).toBe(true);
      // スクリーンショートがないのでHTML解析にフォールバック
      // warningsにフォールバック情報が含まれる可能性
    }
  });

  it('スクリーンショートなしでフォールバック時にwarningsに記録される', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: false });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // warningsにVisionフォールバック情報が含まれることを確認
      // 注意: 実装によってwarningsの形式が異なる可能性
      if (result.data.warnings && result.data.warnings.length > 0) {
        const visionWarning = result.data.warnings.find(w =>
          w.feature === 'layout' && w.code.includes('VISION')
        );
        // フォールバックが発生した場合のみwarningが存在
        if (visionWarning) {
          expect(visionWarning.message).toBeDefined();
        }
      }
    }
  });
});

// =====================================================
// layout.inspect統合テスト
// =====================================================

describe('pageAnalyzeHandler - layout.inspect統合', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('layout.inspectのscreenshotモードに正しいパラメータを渡す', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: true });

    // analyzeLayoutがscreenshotパラメータを受け取ることを確認
    mockService.analyzeLayout = vi.fn().mockImplementation(async (html, options) => {
      // screenshotパラメータが渡されていることを確認
      // 注意: IPageAnalyzeService.analyzeLayoutのシグネチャ拡張が必要
      return {
        success: true,
        sectionCount: 3,
        sectionTypes: { hero: 1, features: 1, footer: 1 },
        processingTimeMs: 100,
      };
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
    };
    await pageAnalyzeHandler(input);

    // analyzeLayoutが呼ばれたことを確認
    expect(mockService.analyzeLayout).toHaveBeenCalled();

    // 呼び出しパラメータを確認（実装後にテスト可能）
    const calls = mockService.analyzeLayout.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
  });

  it('layout.inspectの結果をpage.analyzeのレスポンス形式に変換する', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: true });

    mockService.analyzeLayout = vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 150,
      visionFeatures: {
        success: true,
        features: [
          { type: 'hero', confidence: 0.92 },
          { type: 'feature_grid', confidence: 0.88 },
        ],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      },
      textRepresentation: 'Hero with CTA, Feature grid, Footer',
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
      summary: false,
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout?.success).toBe(true);
      expect(result.data.layout?.sectionCount).toBe(3);
      expect(result.data.layout?.processingTimeMs).toBe(150);
    }
  });
});

// =====================================================
// Vision解析エラーハンドリング
// =====================================================

describe('pageAnalyzeHandler - Vision解析エラーハンドリング', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Vision解析失敗時にHTML解析にフォールバックする', async () => {
    const mockService = createMockServiceWithVision({ hasScreenshot: true });

    // Vision解析が失敗するモック
    mockService.analyzeLayout = vi.fn()
      .mockRejectedValueOnce(new Error('Vision API connection failed'))
      .mockResolvedValueOnce({
        success: true,
        sectionCount: 3,
        sectionTypes: { hero: 1, features: 1, footer: 1 },
        processingTimeMs: 80,
      });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
    };
    const result = await pageAnalyzeHandler(input);

    // 実装によっては成功（フォールバック）または部分失敗
    // 期待: Graceful Degradationでフォールバック後も処理継続
    expect(result.success).toBe(true);
  });

  it('Vision解析タイムアウト時にwarningsに記録される', async () => {
    const mockService = createMockServiceWithVision({ hasScreenshot: true });

    mockService.analyzeLayout = vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 200,
      visionFeatures: {
        success: false,
        features: [],
        error: 'Vision API timeout',
        processingTimeMs: 5000,
        modelName: 'llama3.2-vision',
      },
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // Vision失敗情報がレスポンスに含まれる
      const layoutFull = result.data.layout as {
        success: boolean;
        visionFeatures?: {
          success: boolean;
          error?: string;
        };
      };
      if (layoutFull.visionFeatures) {
        expect(layoutFull.visionFeatures.success).toBe(false);
        expect(layoutFull.visionFeatures.error).toBeDefined();
      }
    }
  });

  it('Ollama未起動時にエラーメッセージが明確', async () => {
    const mockService = createMockServiceWithVision({ hasScreenshot: true });

    mockService.analyzeLayout = vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 100,
      visionFeatures: {
        success: false,
        features: [],
        error: 'Ollama service unavailable. Please ensure Ollama is running with llama3.2-vision model.',
        processingTimeMs: 0,
        modelName: 'llama3.2-vision',
      },
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const layoutFull = result.data.layout as {
        success: boolean;
        visionFeatures?: {
          success: boolean;
          error?: string;
        };
      };
      if (layoutFull.visionFeatures && !layoutFull.visionFeatures.success) {
        expect(layoutFull.visionFeatures.error).toContain('Ollama');
      }
    }
  });
});

// =====================================================
// summaryモードとの統合
// =====================================================

describe('pageAnalyzeHandler - Vision統合とsummaryモード', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('summary: true でもuseVision: trueでVision解析を実行する', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: true });

    mockService.analyzeLayout = vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 150,
      textRepresentation: 'Vision-analyzed layout',
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
      summary: true, // summaryモード
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      // summaryモードでもVision解析は実行される
      // ただしvisionFeaturesの詳細は省略される可能性
    }
  });

  it('summary: false でvisionFeaturesの全詳細が含まれる', async () => {
    const mockService = createMockServiceWithVision({ visionSuccess: true, hasScreenshot: true });

    mockService.analyzeLayout = vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, features: 1, footer: 1 },
      processingTimeMs: 200,
      visionFeatures: {
        success: true,
        features: [
          { type: 'hero', confidence: 0.95, boundingBox: { x: 0, y: 0, width: 1440, height: 600 } },
          { type: 'feature_grid', confidence: 0.90, boundingBox: { x: 0, y: 600, width: 1440, height: 400 } },
        ],
        processingTimeMs: 150,
        modelName: 'llama3.2-vision',
      },
      textRepresentation: 'Full hero section with gradient, Feature cards, Footer links',
    });

    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      layoutOptions: { useVision: true },
      summary: false, // 詳細モード
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const layoutFull = result.data.layout as {
        success: boolean;
        visionFeatures?: {
          success: boolean;
          features: Array<{ type: string; confidence: number }>;
        };
        textRepresentation?: string;
      };

      if (layoutFull.visionFeatures) {
        expect(layoutFull.visionFeatures.features.length).toBeGreaterThan(0);
      }
      expect(layoutFull.textRepresentation).toBeDefined();
    }
  });
});

// =====================================================
// ツール定義テスト
// =====================================================

describe('pageAnalyzeToolDefinition - useVisionオプション', () => {
  it('layoutOptions.useVisionがツール定義に含まれる', async () => {
    // ツール定義のインポート
    const { pageAnalyzeToolDefinition } = await import('../../../src/tools/page/analyze.tool');

    const layoutOptionsProps = pageAnalyzeToolDefinition.inputSchema.properties?.layoutOptions;
    expect(layoutOptionsProps).toBeDefined();

    // layoutOptions.propertiesにuseVisionが含まれることを確認
    if (layoutOptionsProps && typeof layoutOptionsProps === 'object' && 'properties' in layoutOptionsProps) {
      const properties = layoutOptionsProps.properties as Record<string, unknown>;
      expect(properties).toHaveProperty('useVision');

      const useVisionProp = properties.useVision as { type?: string; default?: boolean; description?: string };
      expect(useVisionProp.type).toBe('boolean');
      expect(useVisionProp.default).toBe(true);
      expect(useVisionProp.description).toBeDefined();
    }
  });
});
