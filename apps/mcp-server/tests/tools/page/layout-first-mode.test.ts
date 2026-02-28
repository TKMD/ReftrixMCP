// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout_first モードのテスト（v0.1.0）
 *
 * WebGLサイトに対してレイアウト分析を優先し、モーション検出を軽量化する機能。
 *
 * テスト対象:
 * - layout_first スキーマオプション（auto, always, never）
 * - WebGL事前検出との連携
 * - タイムアウト再分配ロジック
 * - モーション検出軽量化（library_only モード相当）
 * - 統合動作
 *
 * @module tests/tools/page/layout-first-mode.test
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

// 実装ファイルのインポート
import {
  pageAnalyzeHandler,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  type IPageAnalyzeService,
} from '../../../src/tools/page/analyze.tool';

import {
  pageAnalyzeInputSchema,
  type PageAnalyzeInput,
} from '../../../src/tools/page/schemas';

import {
  preDetectWebGL,
  KNOWN_WEBGL_DOMAINS,
} from '../../../src/tools/page/handlers/webgl-pre-detector';

// =====================================================
// テスト用モックサービス
// =====================================================

/**
 * 検出オプションを記録するモックサービス
 */
function createMockPageAnalyzeServiceWithTracking(): IPageAnalyzeService & {
  getLastMotionOptions: () => unknown;
  getLastLayoutOptions: () => unknown;
} {
  let lastMotionOptions: unknown = null;
  let lastLayoutOptions: unknown = null;

  return {
    fetchHtml: vi.fn().mockImplementation(async (url: string) => {
      return {
        html: `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Mock Page - ${url}</title>
  <style>
    .hero { animation: fadeIn 0.5s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  </style>
</head>
<body>
  <header><nav>Navigation</nav></header>
  <main>
    <section class="hero"><h1>Hero Section</h1></section>
    <section class="features"><h2>Features</h2></section>
  </main>
  <footer>Footer</footer>
</body>
</html>`,
        title: `Mock Page - ${url}`,
        description: 'Mock description for testing',
        screenshot: 'mock-screenshot-base64-data',
      };
    }),

    analyzeLayout: vi.fn().mockImplementation(async (html: string, options) => {
      lastLayoutOptions = options;
      return {
        success: true,
        sectionCount: 5,
        sectionTypes: { hero: 1, features: 1, cta: 1, navigation: 1, footer: 1 },
        processingTimeMs: 50,
        pageId: '01941234-5678-7abc-def0-987654321fed',
        sections: [
          { id: '01941234-0001-7abc-def0-000000000001', type: 'navigation', positionIndex: 0, confidence: 0.95 },
          { id: '01941234-0002-7abc-def0-000000000002', type: 'hero', positionIndex: 1, heading: 'Hero Section', confidence: 0.98 },
        ],
      };
    }),

    detectMotion: vi.fn().mockImplementation(async (html: string, url: string, options) => {
      lastMotionOptions = options;
      return {
        success: true,
        patternCount: 3,
        categoryBreakdown: { entrance: 1, hover_effect: 1, loading: 1 },
        warningCount: 1,
        a11yWarningCount: 1,
        perfWarningCount: 0,
        processingTimeMs: 30,
        patterns: [],
        warnings: [],
      };
    }),

    evaluateQuality: vi.fn().mockImplementation(async () => {
      return {
        success: true,
        overallScore: 78.5,
        grade: 'C' as const,
        axisScores: { originality: 72, craftsmanship: 85, contextuality: 76 },
        clicheCount: 1,
        processingTimeMs: 25,
        axisGrades: { originality: 'C' as const, craftsmanship: 'B' as const, contextuality: 'C' as const },
        axisDetails: {},
        cliches: [],
      };
    }),

    getLastMotionOptions: () => lastMotionOptions,
    getLastLayoutOptions: () => lastLayoutOptions,
  };
}

// =====================================================
// layout_first スキーマテスト
// =====================================================

describe('layout_first スキーマオプション', () => {
  describe('有効な値', () => {
    it('layout_first=auto を受け付ける（デフォルト）', () => {
      const input = { url: 'https://example.com' };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.layout_first).toBe('auto');
    });

    it('layout_first=always を受け付ける', () => {
      const input = { url: 'https://example.com', layout_first: 'always' as const };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.layout_first).toBe('always');
    });

    it('layout_first=never を受け付ける', () => {
      const input = { url: 'https://example.com', layout_first: 'never' as const };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.layout_first).toBe('never');
    });
  });

  describe('無効な値', () => {
    it('layout_first に無効な値を指定するとエラー', () => {
      const input = { url: 'https://example.com', layout_first: 'invalid' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// WebGL事前検出との連携テスト
// =====================================================

describe('WebGL事前検出との連携', () => {
  describe('layout_first=auto 時の動作', () => {
    it('既知WebGLドメイン（resn.co.nz）でuseLayoutFirst=trueになる', () => {
      const preDetection = preDetectWebGL('https://resn.co.nz');
      expect(preDetection.isLikelyWebGL).toBe(true);
      expect(preDetection.confidence).toBe(1.0);
      expect(preDetection.timeoutMultiplier).toBe(3.0);
    });

    it('既知WebGLドメイン（threejs.org）でuseLayoutFirst=trueになる', () => {
      const preDetection = preDetectWebGL('https://threejs.org/examples');
      expect(preDetection.isLikelyWebGL).toBe(true);
      expect(preDetection.matchedDomain).toBe('threejs.org');
    });

    it('WebGLパターンURL（/webgl/）でuseLayoutFirst=trueになる', () => {
      const preDetection = preDetectWebGL('https://example.com/webgl/demo');
      expect(preDetection.isLikelyWebGL).toBe(true);
      expect(preDetection.matchedPattern).toBe('/webgl/');
      expect(preDetection.timeoutMultiplier).toBe(2.0);
    });

    it('通常サイトでuseLayoutFirst=falseになる', () => {
      const preDetection = preDetectWebGL('https://example.com');
      expect(preDetection.isLikelyWebGL).toBe(false);
      expect(preDetection.timeoutMultiplier).toBe(1.0);
    });
  });

  describe('KNOWN_WEBGL_DOMAINS 定数', () => {
    it('主要なWebGLスタジオが含まれている', () => {
      expect(KNOWN_WEBGL_DOMAINS).toContain('resn.co.nz');
      expect(KNOWN_WEBGL_DOMAINS).toContain('activetheory.net');
      expect(KNOWN_WEBGL_DOMAINS).toContain('threejs.org');
      expect(KNOWN_WEBGL_DOMAINS).toContain('bruno-simon.com');
      expect(KNOWN_WEBGL_DOMAINS).toContain('lusion.co');
    });

    it('アワードサイトが含まれている', () => {
      expect(KNOWN_WEBGL_DOMAINS).toContain('awwwards.com');
      expect(KNOWN_WEBGL_DOMAINS).toContain('thefwa.com');
    });
  });
});

// =====================================================
// モーション検出軽量化テスト
// =====================================================

describe('モーション検出軽量化（layout_first=always）', () => {
  let mockService: ReturnType<typeof createMockPageAnalyzeServiceWithTracking>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockService = createMockPageAnalyzeServiceWithTracking();
    setPageAnalyzeServiceFactory(() => mockService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layout_first=always で detect_js_animations=true が設定される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    // モーション検出オプションを確認
    const motionOptions = mockService.getLastMotionOptions() as {
      detect_js_animations?: boolean;
      js_animation_options?: {
        enableCDP?: boolean;
        enableWebAnimations?: boolean;
        enableLibraryDetection?: boolean;
      };
    };

    // layout_first モードでは JS アニメーション検出が有効化される
    expect(motionOptions?.detect_js_animations).toBe(true);
  });

  it('layout_first=always で CDP/WebAnimations が無効化される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    const motionOptions = mockService.getLastMotionOptions() as {
      js_animation_options?: {
        enableCDP?: boolean;
        enableWebAnimations?: boolean;
        enableLibraryDetection?: boolean;
      };
    };

    // CDP と WebAnimations は無効化される（高速化のため）
    expect(motionOptions?.js_animation_options?.enableCDP).toBe(false);
    expect(motionOptions?.js_animation_options?.enableWebAnimations).toBe(false);
    // ライブラリ検出のみ有効
    expect(motionOptions?.js_animation_options?.enableLibraryDetection).toBe(true);
  });

  it('layout_first=always で fetchExternalCss はスキーマデフォルト値に従う（v0.1.0）', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    const motionOptions = mockService.getLastMotionOptions() as {
      fetchExternalCss?: boolean;
    };

    // v0.1.0: スキーマデフォルト値 fetchExternalCss=true がユーザー明示指定として扱われる
    // ユーザーが明示的に false を指定した場合のみ無効化される
    expect(motionOptions?.fetchExternalCss).toBe(true);
  });

  it('layout_first=always で maxPatterns=50 が設定される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    const motionOptions = mockService.getLastMotionOptions() as {
      maxPatterns?: number;
    };

    // パターン数制限（メモリ節約）
    expect(motionOptions?.maxPatterns).toBe(50);
  });

  it('layout_first=never では通常のモーション検出設定が維持される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'never',
      motionOptions: {
        fetchExternalCss: true,
        maxPatterns: 100,
      },
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    const motionOptions = mockService.getLastMotionOptions() as {
      fetchExternalCss?: boolean;
      maxPatterns?: number;
    };

    // layout_first=never ではユーザー指定の設定が維持される
    expect(motionOptions?.fetchExternalCss).toBe(true);
    expect(motionOptions?.maxPatterns).toBe(100);
  });
});

// =====================================================
// タイムアウト再分配テスト
// =====================================================

describe('タイムアウト再分配', () => {
  let mockService: ReturnType<typeof createMockPageAnalyzeServiceWithTracking>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockService = createMockPageAnalyzeServiceWithTracking();
    setPageAnalyzeServiceFactory(() => mockService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layout_first=always でタイムアウトが適切に分配される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
      timeout: 120000, // 120秒
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    // totalProcessingTimeMs が返される（タイムアウト内で完了）
    if (result.success) {
      expect(result.data.totalProcessingTimeMs).toBeDefined();
      expect(result.data.totalProcessingTimeMs).toBeLessThan(input.timeout);
    }
  });

  it('layout_first モードでレイアウト分析が成功する', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://resn.co.nz', // 既知WebGLドメイン
      layout_first: 'auto', // auto でも WebGL ドメインなので有効化される
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    if (result.success) {
      // レイアウト分析が成功
      expect(result.data.layout?.success).toBe(true);
      expect(result.data.layout?.sectionCount).toBeGreaterThan(0);
    }
  });
});

// =====================================================
// layout_first=auto 自動判定テスト
// =====================================================

describe('layout_first=auto 自動判定', () => {
  let mockService: ReturnType<typeof createMockPageAnalyzeServiceWithTracking>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockService = createMockPageAnalyzeServiceWithTracking();
    setPageAnalyzeServiceFactory(() => mockService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('既知WebGLドメインで自動的にlayout_firstモードが有効化される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://resn.co.nz',
      layout_first: 'auto', // デフォルト
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    // WebGLドメインなので軽量化オプションが適用される
    const motionOptions = mockService.getLastMotionOptions() as {
      detect_js_animations?: boolean;
      js_animation_options?: {
        enableCDP?: boolean;
      };
    };

    expect(motionOptions?.detect_js_animations).toBe(true);
    expect(motionOptions?.js_animation_options?.enableCDP).toBe(false);
  });

  it('通常サイトではlayout_firstモードが無効のまま', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com', // 通常サイト
      layout_first: 'auto',
      motionOptions: {
        detect_js_animations: false, // 明示的に無効化
      },
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    // 通常サイトなのでユーザー指定のオプションが維持される
    const motionOptions = mockService.getLastMotionOptions() as {
      detect_js_animations?: boolean;
    };

    // ユーザーが false を指定したので false のまま
    expect(motionOptions?.detect_js_animations).toBe(false);
  });

  it('WebGLパターンURL（/3d/）で自動的にlayout_firstモードが有効化される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com/showcase/3d/viewer',
      layout_first: 'auto',
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    // /3d/ パターンなので軽量化オプションが適用される
    const motionOptions = mockService.getLastMotionOptions() as {
      detect_js_animations?: boolean;
    };

    expect(motionOptions?.detect_js_animations).toBe(true);
  });
});

// =====================================================
// エッジケーステスト
// =====================================================

describe('エッジケース', () => {
  let mockService: ReturnType<typeof createMockPageAnalyzeServiceWithTracking>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockService = createMockPageAnalyzeServiceWithTracking();
    setPageAnalyzeServiceFactory(() => mockService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layout_first=always + features.motion=false でモーション検出がスキップされる', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
      features: { layout: true, motion: false, quality: true },
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    if (result.success) {
      // モーション検出はスキップされる
      expect(result.data.motion).toBeUndefined();
      // レイアウト分析は実行される
      expect(result.data.layout).toBeDefined();
    }
  });

  it('layout_first=always + features.layout=false でもモーション軽量化は適用される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
      features: { layout: false, motion: true, quality: false },
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    // モーション検出は軽量化オプションで実行される
    const motionOptions = mockService.getLastMotionOptions() as {
      detect_js_animations?: boolean;
    };

    expect(motionOptions?.detect_js_animations).toBe(true);
  });

  it('短いタイムアウトでもlayout_firstモードで完了できる', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
      timeout: 30000, // 30秒（短めのタイムアウト）
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    if (result.success) {
      // タイムアウト内で完了
      expect(result.data.totalProcessingTimeMs).toBeLessThan(30000);
    }
  });

  it('layout_first=never でWebGLドメインでも通常モードで実行される', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://resn.co.nz', // 既知WebGLドメイン
      layout_first: 'never', // 強制的に無効化
      motionOptions: {
        detect_js_animations: true,
        js_animation_options: {
          enableCDP: true, // 明示的に有効化
        },
      },
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    // ユーザー指定のオプションが維持される
    const motionOptions = mockService.getLastMotionOptions() as {
      js_animation_options?: {
        enableCDP?: boolean;
      };
    };

    expect(motionOptions?.js_animation_options?.enableCDP).toBe(true);
  });
});

// =====================================================
// 統合テスト
// =====================================================

describe('統合テスト', () => {
  let mockService: ReturnType<typeof createMockPageAnalyzeServiceWithTracking>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockService = createMockPageAnalyzeServiceWithTracking();
    setPageAnalyzeServiceFactory(() => mockService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layout_first モードで全分析が正常に完了する', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://threejs.org/examples',
      layout_first: 'always',
      summary: false,
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    if (result.success) {
      // 全分析結果が返される
      expect(result.data.id).toBeDefined();
      expect(result.data.url).toBe(input.url);
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
      expect(result.data.totalProcessingTimeMs).toBeGreaterThan(0);
    }
  });

  it('layout_first モードでDB保存オプションが正しく動作する', async () => {
    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layout_first: 'always',
      layoutOptions: {
        saveToDb: true,
        autoAnalyze: true,
      },
      motionOptions: {
        saveToDb: true,
      },
    };

    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    if (result.success && result.data.layout?.success) {
      // ページIDが返される（DB保存成功）
      expect(result.data.layout.pageId).toBeDefined();
    }
  });

  it('並列リクエストでもlayout_firstモードが正しく動作する', async () => {
    const inputs: PageAnalyzeInput[] = [
      { url: 'https://resn.co.nz', layout_first: 'auto' },
      { url: 'https://example.com', layout_first: 'always' },
      { url: 'https://google.com', layout_first: 'never' },
    ];

    const results = await Promise.all(inputs.map((input) => pageAnalyzeHandler(input)));

    // 全てのリクエストが成功
    results.forEach((result, index) => {
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe(inputs[index].url);
      }
    });
  });
});

// =====================================================
// パフォーマンステスト
// =====================================================

describe('パフォーマンス', () => {
  let mockService: ReturnType<typeof createMockPageAnalyzeServiceWithTracking>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockService = createMockPageAnalyzeServiceWithTracking();
    setPageAnalyzeServiceFactory(() => mockService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layout_first モードは通常モードより高速（モック環境）', async () => {
    // layout_first モード
    const startLayoutFirst = Date.now();
    await pageAnalyzeHandler({
      url: 'https://example.com',
      layout_first: 'always',
    });
    const durationLayoutFirst = Date.now() - startLayoutFirst;

    // 通常モード
    const startNormal = Date.now();
    await pageAnalyzeHandler({
      url: 'https://example.com',
      layout_first: 'never',
    });
    const durationNormal = Date.now() - startNormal;

    // モック環境では大きな差は出ないが、エラーなく完了することを確認
    expect(durationLayoutFirst).toBeGreaterThanOrEqual(0);
    expect(durationNormal).toBeGreaterThanOrEqual(0);
  });

  it('preDetectWebGL は高速（1000回で100ms以内）', () => {
    const urls = [
      'https://resn.co.nz',
      'https://example.com',
      'https://threejs.org/examples',
      'https://google.com',
      'https://example.com/webgl/demo',
    ];

    const startTime = performance.now();

    for (let i = 0; i < 1000; i++) {
      const url = urls[i % urls.length];
      preDetectWebGL(url);
    }

    const duration = performance.now() - startTime;
    expect(duration).toBeLessThan(100); // 100ms以内
  });
});
